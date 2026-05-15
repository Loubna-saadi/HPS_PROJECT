import { Component, OnInit, ChangeDetectorRef, ChangeDetectionStrategy } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { CommonModule, DatePipe, DecimalPipe } from '@angular/common';
import { RouterModule } from '@angular/router';
import { forkJoin } from 'rxjs';
import { AuthService } from '../../../core/services/auth';

const ORDS = 'http://localhost:8080/ords/v1';

interface DashboardStats {
  last_audit_date: string;
  total_anomalies: number;
  sync_rate:       number;
  total_reports:   number;
}

interface Operation {
  id: number;
  type: string;
  statut: string;
  date_operation: string;
  source_env: string;
  cible_env: string;
  tables_impactees: number;
  nb_anomalies: number;
}

interface DriftTable {
  nom_table: string;
  total_anomalies: number;
  absences: number;
  differences: number;
  nulls: number;
  last_seen: string;
}

@Component({
  selector: 'app-dashboard',
  standalone: true,
  imports: [CommonModule, RouterModule, DatePipe, DecimalPipe],
  templateUrl: './dashboard.html',
  styleUrls: ['./dashboard.css'],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class DashboardComponent implements OnInit {

  lastAuditDate: string | null = null;
  totalAnomalies: number = 0;
  syncRate: number = 0;
  totalReports: number = 0;

  recentOperations: Operation[] = [];
  driftByTable: DriftTable[] = [];

  loading = true;
  error = false;

  constructor(
    private http:        HttpClient,
    private cdr:         ChangeDetectorRef,
    private authService: AuthService
  ) {}

  ngOnInit(): void {
    const userId = this.authService.getUserId();

    // Guard: if no user in storage, skip fetching
    if (!userId) {
      this.error   = true;
      this.loading = false;
      this.cdr.markForCheck();
      return;
    }

    const params = { userId: userId.toString() };

    forkJoin({
      stats:      this.http.get<{ items: DashboardStats[] }>(`${ORDS}/audit/dashboard-stats`,    { params }),
      operations: this.http.get<{ items: Operation[] }>     (`${ORDS}/audit/operations/recent`,  { params }),
      drift:      this.http.get<{ items: DriftTable[] }>    (`${ORDS}/audit/drift-by-table`,     { params }),
    }).subscribe({
      next: ({ stats, operations, drift }) => {
        const s = stats.items?.[0];
        if (s) {
          this.lastAuditDate  = s.last_audit_date;
          this.totalAnomalies = s.total_anomalies ?? 0;
          this.syncRate       = s.sync_rate       ?? 0;
          this.totalReports   = s.total_reports   ?? 0;
        }
        this.recentOperations = operations.items ?? [];
        this.driftByTable     = drift.items      ?? [];
        this.loading = false;
        this.error   = false;
        this.cdr.markForCheck();
      },
      error: () => {
        this.error   = true;
        this.loading = false;
        this.cdr.markForCheck();
      }
    });
  }

  getStatusLabel(statut: string): string {
    const map: Record<string, string> = {
      'TERMINE': 'Synchronisé',
      'ANOMALIES_GENEREES': 'Écarts détectés',
      'EN_COURS': 'En cours',
      'ERREUR': 'Erreur'
    };
    return map[statut] ?? statut;
  }

  getStatusClass(statut: string): string {
    const map: Record<string, string> = {
      'TERMINE': 'success',
      'ANOMALIES_GENEREES': 'warning',
      'EN_COURS': 'info',
      'ERREUR': 'danger'
    };
    return map[statut] ?? 'secondary';
  }

  getDriftBarWidth(table: DriftTable): number {
    if (!this.driftByTable.length) return 0;
    const max = Math.max(...this.driftByTable.map(t => t.total_anomalies));
    return max > 0 ? Math.round((table.total_anomalies / max) * 100) : 0;
  }

  getDriftColor(table: DriftTable): string {
    const ratio = table.total_anomalies;
    if (ratio > 20) return 'bg-danger';
    if (ratio > 5)  return 'bg-warning';
    return 'bg-success';
  }

  getTopDriftTable(): DriftTable | null {
    return this.driftByTable[0] ?? null;
  }

  formatRelativeDate(dateStr: string): string {
    if (!dateStr) return '—';
    const date = new Date(dateStr);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMin = Math.floor(diffMs / 60000);
    const diffH   = Math.floor(diffMin / 60);
    const diffD   = Math.floor(diffH / 24);

    if (diffMin < 2)  return "À l'instant";
    if (diffMin < 60) return `Il y a ${diffMin} min`;
    if (diffH < 24)   return `Il y a ${diffH}h`;
    if (diffD === 1)  return 'Hier';
    return date.toLocaleDateString('fr-FR', { day: '2-digit', month: 'short' });
  }
}