import { Component, OnInit, ChangeDetectorRef, ChangeDetectionStrategy } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { CommonModule, DatePipe, DecimalPipe } from '@angular/common';
import { RouterModule } from '@angular/router';

const ORDS = 'http://localhost:3000/v1';

interface Operation {
  id:               number;
  type:             string;
  statut:           string;
  date_operation:   string;
  source_env:       string;
  cible_env:        string;
  tables_impactees: number;
  nb_anomalies:     number;
}

interface DriftTable {
  nom_table:       string;
  total_anomalies: number;
  absences:        number;
  differences:     number;
  nulls:           number;
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

  lastAuditDate:  string | null = null;
  totalAnomalies  = 0;
  syncRate        = 0;
  totalReports    = 0;

  recentOperations: Operation[]  = [];
  driftByTable:     DriftTable[] = [];

  loading = true;
  error   = false;

  constructor(
    private http: HttpClient,
    private cdr:  ChangeDetectorRef
  ) {}

  ngOnInit(): void { this.load(); }

  load(): void {
    this.loading = true;
    this.http.get<any>(`${ORDS}/audit/dashboard`).subscribe({
      next: (d) => {
        // ── KPIs ─────────────────────────────────────────────────────────────
        this.lastAuditDate  = d.kpis?.last_audit_date  ?? null;
        this.totalAnomalies = d.kpis?.open_anomalies   ?? 0;
        this.syncRate       = d.kpis?.sync_rate        ?? 0;
        this.totalReports   = d.kpis?.total_operations ?? 0;

        // ── Recent operations → map to old shape ──────────────────────────────
        this.recentOperations = (d.recent_operations ?? []).map((op: any) => ({
          id:               op.id,
          type:             op.type,
          statut:           op.statut,
          date_operation:   op.date_operation,
          source_env:       op.source_env,
          cible_env:        op.cible_env,
          tables_impactees: op.tables_scanned ?? 1,
          nb_anomalies:     op.nb_anomalies   ?? 0,
        }));

        // ── Top tables → map to old DriftTable shape ──────────────────────────
        this.driftByTable = (d.top_tables ?? []).map((t: any) => ({
          nom_table:       t.nom_table,
          total_anomalies: t.total,
          absences:        (t.absent_cible ?? 0) + (t.absent_source ?? 0),
          differences:     t.differente ?? 0,
          nulls:           t.null_val   ?? 0,
        }));

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
      'TERMINE':            'Synchronisé',
      'ANOMALIES_GENEREES': 'Écarts détectés',
      'SCRIPT_GENERE':      'Script généré',
      'SCRIPT_VALIDE':      'Script validé',
      'IMPORTE':            'Importé',
      'EN_COURS':           'En cours',
      'ERREUR':             'Erreur'
    };
    return map[statut] ?? statut;
  }

  getStatusClass(statut: string): string {
    const map: Record<string, string> = {
      'TERMINE':            'success',
      'ANOMALIES_GENEREES': 'warning',
      'EN_COURS':           'info',
      'ERREUR':             'danger'
    };
    return map[statut] ?? 'secondary';
  }

  getDriftBarWidth(table: DriftTable): number {
    if (!this.driftByTable.length) return 0;
    const max = Math.max(...this.driftByTable.map(t => t.total_anomalies));
    return max > 0 ? Math.round((table.total_anomalies / max) * 100) : 0;
  }

  getDriftColor(table: DriftTable): string {
    if (table.total_anomalies > 20) return 'bg-danger';
    if (table.total_anomalies > 5)  return 'bg-warning';
    return 'bg-success';
  }

  getTopDriftTable(): DriftTable | null {
    return this.driftByTable[0] ?? null;
  }

  formatRelativeDate(dateStr: string): string {
    if (!dateStr) return '—';
    const diff   = Date.now() - new Date(dateStr).getTime();
    const diffMin = Math.floor(diff / 60000);
    const diffH   = Math.floor(diffMin / 60);
    const diffD   = Math.floor(diffH / 24);
    if (diffMin < 2)  return "À l'instant";
    if (diffMin < 60) return `Il y a ${diffMin} min`;
    if (diffH < 24)   return `Il y a ${diffH}h`;
    if (diffD === 1)  return 'Hier';
    return new Date(dateStr).toLocaleDateString('fr-FR', { day: '2-digit', month: 'short' });
  }
}
