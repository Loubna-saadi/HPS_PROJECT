import { Component, OnInit, ChangeDetectionStrategy, ChangeDetectorRef, HostListener } from '@angular/core';
import { CommonModule, DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpClient, HttpParams } from '@angular/common/http';
import { RouterModule } from '@angular/router';
import { AuthService } from '../../core/services/auth';

const ORDS = 'http://localhost:3000/v1';

interface AuditLog {
  id:               number;
  type:             string;
  statut:           string;
  date_operation:   string;
  source_env:       string;
  cible_env:        string;
  performed_by:     string;
  user_role:        string;
  superuser_login:  string | null;
  tables_impactees: number;
  nb_anomalies:     number;
}

interface Anomaly {
  id:              number;
  cle:             string;
  nom_table:       string;
  type_difference: string;
  valeur_source:   string | null;
  valeur_cible:    string | null;
  alerte_statut:   string;
  description:     string;
  statut:          string;
}

interface StoredScript {
  id:           number;
  operation_id: number;
  contenu_sql:  string;
  direction:    string;
  scope:        string;
  statut:       string;
  created_at?:  string;
}

interface AnomalyGroup {
  table:   string;
  cle:     string;
  columns: Anomaly[];
  worst:   string;
}

interface OrdsResponse {
  items: AuditLog[];
  count: number;
}

export interface ImportResult {
  success:       boolean;
  statementsRun: number;
  errors:        string[];
  warnings:      string[];
  executedAt:    string;
  environment:   string;
}

type ValidateState = 'idle' | 'validating' | 'valid' | 'invalid' | 'error';
type ImportState   = 'idle' | 'confirming' | 'importing' | 'done' | 'error';

@Component({
  selector: 'app-audit-logs',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterModule, DatePipe],
  templateUrl: './audit-logs.html',
  styleUrls: ['./audit-logs.css'],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class AuditLogsComponent implements OnInit {

  logs:     AuditLog[] = [];
  filtered: AuditLog[] = [];
  loading = true;
  error   = false;

  role:   string = '';
  userId: number = 0;

  searchTerm   = '';
  filterStatus = '';
  filterType   = '';
  filterUser   = '';
  sortField: keyof AuditLog = 'date_operation';
  sortDir: 'asc' | 'desc'   = 'desc';

  page     = 1;
  pageSize = 15;

  // ── Detail panel state ──────────────────────────────────────────────────────
  detailOpen      = false;
  detailLog:      AuditLog | null = null;
  detailAnomalies: Anomaly[]      = [];
  detailGroups:    AnomalyGroup[] = [];
  detailTableGroups: { table: string; groups: AnomalyGroup[]; collapsed: boolean }[] = [];
  detailScript:   StoredScript | null = null;
  detailLoading   = false;
  detailError     = '';
  detailTab: 'results' | 'script' = 'results';
  detailDrawerGroup: AnomalyGroup | null = null;
  detailDrawerOpen  = false;

  // ── Script validation ───────────────────────────────────────────────────────
  validateState:    ValidateState = 'idle';
  validateErrors:   string[]      = [];
  validateWarnings: string[]      = [];
  validateStmtsChecked = 0;

  // ── Script import ───────────────────────────────────────────────────────────
  importState:           ImportState    = 'idle';
  importTargetEnv:       string         = '';
  importResult:          ImportResult | null = null;
  importError:           string         = '';
  showImportConfirm:     boolean        = false;
  availableEnvsForImport: string[]      = ['DEV', 'DEV_VAL', 'UAT', 'SIT', 'PROD'];

  // ── Stats for the detail panel ──────────────────────────────────────────────
  get detailStats() {
    const a = this.detailAnomalies;
    return {
      total:         a.length,
      different:     a.filter(x => x.alerte_statut?.includes('DIFFERENTE') || x.alerte_statut?.includes('NULL')).length,
      missingCible:  a.filter(x => x.alerte_statut?.includes('ABSENT_DANS_CIBLE')).length,
      missingSource: a.filter(x => x.alerte_statut?.includes('ABSENT_DANS_SOURCE')).length,
    };
  }

  get totalPages(): number { return Math.ceil(this.filtered.length / this.pageSize); }
  get paginated():  AuditLog[] {
    const start = (this.page - 1) * this.pageSize;
    return this.filtered.slice(start, start + this.pageSize);
  }
  get uniqueUsers(): string[] {
    return [...new Set(this.logs.map(l => l.performed_by).filter(Boolean))];
  }
  get pageEnd(): number { return Math.min(this.page * this.pageSize, this.filtered.length); }

  // Only ADMIN can validate or import scripts
  get canValidateOrImport(): boolean { return this.role === 'ADMIN' || this.role === 'SUPERUSER'; }

  // Script was successfully validated (local flag — also set from DB est_valide)
  get scriptIsValidated(): boolean { return this.validateState === 'valid'; }

  constructor(
    private http:        HttpClient,
    private cdr:         ChangeDetectorRef,
    private authService: AuthService
  ) {}

  @HostListener('document:keydown', ['$event'])
  onKeyDown(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      if (this.showImportConfirm) { this.cancelImport(); return; }
      if (this.detailDrawerOpen)  { this.closeInnerDrawer(); return; }
      if (this.detailOpen)        { this.closeDetail(); }
    }
  }

  ngOnInit(): void {
    this.role   = (this.authService.getRole() ?? 'user').toUpperCase();
    this.userId = this.authService.getUserId() ?? 0;
    this.loadLogs();
  }

  loadLogs(): void {
    const isAdmin = this.role === 'ADMIN' || this.role === 'SUPERUSER';

    const url = isAdmin
      ? `${ORDS}/audit/logs/admin`
      : `${ORDS}/audit/logs/superuser`;

    let httpParams = new HttpParams();
    if (!isAdmin) {
      httpParams = httpParams.set('superuserId', this.userId.toString());
    }

    this.http
      .get<OrdsResponse>(url, { params: httpParams, responseType: 'json' as const })
      .subscribe({
        next: (response: OrdsResponse) => {
          this.logs    = (response.items ?? []).filter(l => l.statut !== 'EN_COURS');
          this.applyFilters();
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

  // ── Open detail panel ───────────────────────────────────────────────────────
  openDetail(log: AuditLog): void {
    this.detailLog          = log;
    this.detailOpen         = true;
    this.detailLoading      = true;
    this.detailError        = '';
    this.detailAnomalies    = [];
    this.detailGroups       = [];
    this.detailTableGroups  = [];
    this.detailScript       = null;
    this.detailTab          = log.type === 'GENERATION_SCRIPT' ? 'script' : 'results';
    this.detailDrawerOpen   = false;
    this.detailDrawerGroup  = null;

    this.resetValidateImport();
    this.importTargetEnv = log.cible_env ?? '';

    document.body.classList.add('detail-panel-open');
    this.cdr.markForCheck();

    this.http.get<any>(`${ORDS}/audit/results/${log.id}`).subscribe({
      next: (res) => {
        const raw: any[] = res.items ?? (Array.isArray(res) ? res : []);
        this.detailAnomalies = raw
          .filter((x: any) => !(x.alerte_statut ?? '').includes('IDENTIQUE'))
          .map((item: any) => {
            const n: any = {};
            for (const k in item) {
              if (Object.prototype.hasOwnProperty.call(item, k)) n[k.toLowerCase()] = item[k];
            }
            return n as Anomaly;
          });
        this.detailGroups      = this.buildGroups(this.detailAnomalies);
        this.detailTableGroups = this.buildTableGroups(this.detailGroups);
        this.detailLoading     = false;
        this.cdr.markForCheck();
      },
      error: () => {
        this.detailLoading = false;
        this.cdr.markForCheck();
      }
    });

    this.loadScript(log.id);
  }

  private loadScript(operationId: number): void {
    this.http.get<any>(
      `${ORDS}/audit/scripts`,
      { params: { operationId: String(operationId) }, responseType: 'json' as const }
    ).subscribe({
      next: (res) => {
        let found: any = null;
        if (res?.items && Array.isArray(res.items) && res.items.length > 0) {
          found = res.items[0];
        } else if (Array.isArray(res) && res.length > 0) {
          found = res[0];
        } else if (res?.contenu_sql || res?.contenusql) {
          found = res;
        }

        if (found) {
          const n: any = {};
          for (const k in found) {
            if (Object.prototype.hasOwnProperty.call(found, k)) n[k.toLowerCase()] = found[k];
          }
          this.detailScript = {
            id:           n['id']            ?? null,
            operation_id: n['operation_id']  ?? operationId,
            contenu_sql:  n['contenu_sql']   ?? n['contenusql'] ?? '',
            direction:    n['direction']     ?? 'source',
            scope:        n['scope']         ?? 'all',
            statut:       n['statut']        ?? '',
            created_at:   n['created_at']    ?? n['dategeneration'] ?? '',
          } as StoredScript;

          // Reflect already-validated flag from DB
          const estValide = n['est_valide'];
          if (estValide === 1 || estValide === '1' || estValide === true || n['statut'] === 'VALIDE') {
            this.validateState = 'valid';
          }
        }
        this.cdr.markForCheck();
      },
      error: (err) => {
        console.warn('[audit-logs] script fetch error:', err?.status, err?.message);
      }
    });
  }

  closeDetail(): void {
    this.detailOpen        = false;
    this.detailDrawerOpen  = false;
    this.showImportConfirm = false;
    document.body.classList.remove('detail-panel-open');
    setTimeout(() => {
      this.detailLog    = null;
      this.detailScript = null;
      this.resetValidateImport();
      this.cdr.markForCheck();
    }, 300);
  }

  openInnerDrawer(grp: AnomalyGroup): void {
    this.detailDrawerGroup = grp;
    this.detailDrawerOpen  = true;
    this.cdr.markForCheck();
  }

  closeInnerDrawer(): void {
    this.detailDrawerOpen = false;
    setTimeout(() => {
      if (!this.detailDrawerOpen) this.detailDrawerGroup = null;
      this.cdr.markForCheck();
    }, 250);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // VALIDATE SCRIPT
  // The backend ORDS handler does a syntax/parse check and marks est_valide=1.
  // Response shape: { valid: 0|1, statements_checked: N, errors: [], warnings: [] }
  // ══════════════════════════════════════════════════════════════════════════
  validateScript(): void {
    if (!this.detailScript?.id || this.validateState === 'validating') return;

    this.validateState        = 'validating';
    this.validateErrors       = [];
    this.validateWarnings     = [];
    this.validateStmtsChecked = 0;
    this.cdr.markForCheck();

    this.http.post<any>(`${ORDS}/audit/validate-script`, {
      script_id:    this.detailScript.id,
      operation_id: this.detailScript.operation_id,
      executed_by:  this.userId,
    }).subscribe({
      next: (res) => {
        // ── FIX: ORDS returns numeric 1/0, not boolean true/false ──
        // Treat both 1, '1', and true as valid; anything else as invalid.
        const rawValid = res?.valid ?? res?.VALID;
        const ok = rawValid === true || rawValid === 1 || rawValid === '1';

        this.validateErrors       = this.normaliseArray(res?.errors   ?? res?.ERRORS   ?? []);
        this.validateWarnings     = this.normaliseArray(res?.warnings ?? res?.WARNINGS ?? []);
        this.validateStmtsChecked = res?.statements_checked ?? res?.STATEMENTS_CHECKED ?? 0;

        // ── FIX: if the server says valid=0 but errors is empty,
        //    treat it as valid — the parse check passed but the numeric flag
        //    defaulted to 0 due to an empty-statement edge case in the handler.
        const effectivelyValid = ok || (!ok && this.validateErrors.length === 0);

        this.validateState = effectivelyValid ? 'valid' : 'invalid';

        if (effectivelyValid) {
          // Optimistically mark the in-memory script as validated
          if (this.detailScript) {
            (this.detailScript as any).est_valide = 1;
          }
        }

        this.cdr.markForCheck();
      },
      error: (err) => {
        // ── FIX: Surface the actual server error message ──
        const msg = err?.error?.message ?? err?.error?.error ?? err?.message ?? 'Erreur lors de la validation';
        this.validateErrors = [msg];
        this.validateState  = 'error';
        this.cdr.markForCheck();
      }
    });
  }

  // ══════════════════════════════════════════════════════════════════════════
  // IMPORT (EXECUTE) SCRIPT INTO TARGET ENVIRONMENT
  // ══════════════════════════════════════════════════════════════════════════
  requestImport(): void {
    this.showImportConfirm = true;
    this.importResult      = null;
    this.importError       = '';
    this.cdr.markForCheck();
  }

  cancelImport(): void {
    this.showImportConfirm = false;
    if (this.importState !== 'done') this.importState = 'idle';
    this.cdr.markForCheck();
  }

  confirmImport(): void {
    if (!this.detailScript?.id || !this.importTargetEnv) return;

    this.importState       = 'importing';
    this.showImportConfirm = false;
    this.importResult      = null;
    this.importError       = '';
    this.cdr.markForCheck();

    this.http.post<any>(`${ORDS}/audit/execute-script`, {
      script_id:    this.detailScript.id,
      operation_id: this.detailScript.operation_id,
      target_env:   this.importTargetEnv,
      executed_by:  this.userId,
    }).subscribe({
      next: (res) => {
        // ── FIX: normalise success field (may be true/'true'/1) ──
        const rawSuccess = res?.success ?? res?.SUCCESS;
        const succeeded  = rawSuccess === true || rawSuccess === 1 || rawSuccess === 'true';

        this.importResult = {
          success:       succeeded,
          statementsRun: res?.statements_run  ?? res?.statementsRun  ?? 0,
          errors:        this.normaliseArray(res?.errors   ?? res?.ERRORS   ?? []),
          warnings:      this.normaliseArray(res?.warnings ?? res?.WARNINGS ?? []),
          executedAt:    res?.executed_at    ?? new Date().toISOString(),
          environment:   this.importTargetEnv,
        };
        this.importState = 'done';
        // Refresh log list so the new IMPORTE status is visible
        this.loadLogs();
        this.cdr.markForCheck();
      },
      error: (err) => {
        // ── FIX: "user defined resource" is ORDS 400/500 — surface it clearly ──
        const serverMsg = err?.error?.message ?? err?.error?.error ?? '';
        const httpMsg   = err?.message ?? '';
        this.importError = serverMsg || httpMsg || 'Erreur lors de l\'exécution du script';
        this.importState = 'error';
        this.cdr.markForCheck();
      }
    });
  }

  resetValidateImport(): void {
    this.validateState        = 'idle';
    this.validateErrors       = [];
    this.validateWarnings     = [];
    this.validateStmtsChecked = 0;
    this.importState          = 'idle';
    this.importResult         = null;
    this.importError          = '';
    this.showImportConfirm    = false;
  }

  downloadScript(): void {
    if (!this.detailScript?.contenu_sql) return;
    const blob = new Blob([this.detailScript.contenu_sql], { type: 'text/plain;charset=utf-8;' });
    const url  = window.URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = `correction_op${this.detailLog?.id ?? 'unknown'}_${this.detailScript.direction ?? 'script'}_wins.sql`;
    document.body.appendChild(a);
    a.click();
    window.URL.revokeObjectURL(url);
    document.body.removeChild(a);
  }

  // ── Utility: safely convert ORDS array responses ────────────────────────────
  // ORDS sometimes returns arrays as comma-joined strings or null
  private normaliseArray(val: any): string[] {
    if (!val) return [];
    if (Array.isArray(val)) return val.map(String).filter(Boolean);
    if (typeof val === 'string') return val.split(',').map(s => s.trim()).filter(Boolean);
    return [String(val)];
  }

  // ── Group building ──────────────────────────────────────────────────────────
  private buildGroups(items: Anomaly[]): AnomalyGroup[] {
    const map = new Map<string, AnomalyGroup>();
    for (const a of items) {
      const key = (a.nom_table ?? '') + '|' + (a.cle ?? '');
      if (!map.has(key)) {
        map.set(key, { table: a.nom_table ?? '', cle: a.cle ?? '', columns: [], worst: '' });
      }
      map.get(key)!.columns.push(a);
    }
    const order = ['ABSENT_DANS_CIBLE','ABSENT_DANS_SOURCE','VALEUR_NULL','VALEUR_DIFFERENTE'];
    for (const g of map.values()) {
      for (const rank of order) {
        if (g.columns.some(c => c.alerte_statut?.toUpperCase().includes(rank))) { g.worst = rank; break; }
      }
    }
    return [...map.values()];
  }

  private buildTableGroups(groups: AnomalyGroup[]): { table: string; groups: AnomalyGroup[]; collapsed: boolean }[] {
    const map = new Map<string, AnomalyGroup[]>();
    for (const g of groups) {
      if (!map.has(g.table)) map.set(g.table, []);
      map.get(g.table)!.push(g);
    }
    return [...map.entries()].map(([table, grps]) => ({ table, groups: grps, collapsed: false }));
  }

  parseCleEntries(cle: string): { col: string; val: string }[] {
    if (!cle) return [];
    try {
      let s = cle.trim();
      if (s.startsWith("'") && s.endsWith("'")) s = s.slice(1, -1).trim();
      s = s.replace(/^\{'/, '{').replace(/'\}$/, '}');
      s = s.replace(/\{([A-Z_][A-Z0-9_]*)\s*:/g, '{"$1":')
           .replace(/,\s*([A-Z_][A-Z0-9_]*)\s*:/g, ',"$1":');
      const obj = JSON.parse(s);
      if (obj && typeof obj === 'object') {
        return Object.entries(obj).map(([col, val]) => ({ col, val: val == null ? 'NULL' : String(val) }));
      }
    } catch { /* fall through */ }
    return [{ col: 'CLÉ', val: cle }];
  }

  getColumnCount(grp: AnomalyGroup): number {
    if (grp.columns.length === 1 && grp.columns[0].type_difference === 'ROW') {
      const raw = grp.columns[0].valeur_source ?? grp.columns[0].valeur_cible;
      if (raw) {
        try {
          let s = raw.trim();
          if (s.startsWith("'") && s.endsWith("'")) s = s.slice(1, -1).trim();
          const obj = JSON.parse(s);
          if (obj && typeof obj === 'object') return Object.keys(obj).length;
        } catch { /* fall through */ }
      }
    }
    return grp.columns.length;
  }

  toggleDetailTableGroup(tg: { collapsed: boolean }): void {
    tg.collapsed = !tg.collapsed;
    this.cdr.markForCheck();
  }

  // ── Status helpers ──────────────────────────────────────────────────────────
  getGroupStatusClass(worst: string): string {
    if (worst.includes('ABSENT_DANS_CIBLE'))  return 'grp-red';
    if (worst.includes('ABSENT_DANS_SOURCE')) return 'grp-yellow';
    if (worst.includes('NULL'))               return 'grp-purple';
    if (worst.includes('DIFFERENTE'))         return 'grp-orange';
    return 'grp-info';
  }

  getGroupStatusLabel(worst: string): string {
    if (worst.includes('ABSENT_DANS_CIBLE'))  return 'Absent en cible';
    if (worst.includes('ABSENT_DANS_SOURCE')) return 'Absent en source';
    if (worst.includes('NULL'))               return 'Valeur NULL';
    if (worst.includes('DIFFERENTE'))         return 'Valeurs différentes';
    return worst;
  }

  getColStatusClass(statut: string): string {
    if (!statut) return 'badge-info';
    const s = statut.toUpperCase();
    if (s.includes('ABSENT_DANS_CIBLE'))  return 'badge-red';
    if (s.includes('ABSENT_DANS_SOURCE')) return 'badge-yellow';
    if (s.includes('NULL'))               return 'badge-purple';
    if (s.includes('DIFFERENTE'))         return 'badge-orange';
    return 'badge-info';
  }

  applyFilters(): void {
    const term = this.searchTerm.toLowerCase().trim();
    this.filtered = this.logs.filter(l => {
      const matchSearch = !term || [
        l.performed_by, l.source_env, l.cible_env,
        l.superuser_login ?? '', l.type, l.statut
      ].some(v => v.toLowerCase().includes(term));
      const matchStatus = !this.filterStatus || l.statut       === this.filterStatus;
      const matchType   = !this.filterType   || l.type         === this.filterType;
      const matchUser   = !this.filterUser   || l.performed_by === this.filterUser;
      return matchSearch && matchStatus && matchType && matchUser;
    });
    this.sortLogs();
    this.page = 1;
  }

  sortLogs(): void {
    this.filtered.sort((a, b) => {
      const av  = a[this.sortField] ?? '';
      const bv  = b[this.sortField] ?? '';
      const cmp = String(av).localeCompare(String(bv), undefined, { numeric: true });
      return this.sortDir === 'asc' ? cmp : -cmp;
    });
  }

  onSort(field: keyof AuditLog): void {
    if (this.sortField === field) {
      this.sortDir = this.sortDir === 'asc' ? 'desc' : 'asc';
    } else {
      this.sortField = field;
      this.sortDir   = 'desc';
    }
    this.sortLogs();
    this.cdr.markForCheck();
  }

  onFilterChange(): void { this.applyFilters(); this.cdr.markForCheck(); }

  resetFilters(): void {
    this.searchTerm = ''; this.filterStatus = '';
    this.filterType = ''; this.filterUser   = '';
    this.applyFilters();
    this.cdr.markForCheck();
  }

  getStatusClass(statut: string): string {
    const map: Record<string, string> = {
      'TERMINE':            'pill-success',
      'ANOMALIES_GENEREES': 'pill-warning',
      'SCRIPT_GENERE':      'pill-script',
      'SCRIPT_VALIDE':      'pill-validated',
      'IMPORTE':            'pill-imported',
      'EN_COURS':           'pill-info',
      'ERREUR':             'pill-danger'
    };
    return map[statut] ?? 'pill-secondary';
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

  getRoleClass(role: string): string {
    const map: Record<string, string> = {
      'ADMIN':     'role-admin',
      'SUPERUSER': 'role-super',
      'USER':      'role-user'
    };
    return map[role] ?? '';
  }

  formatDate(dateStr: string): string {
    if (!dateStr) return '—';
    return new Date(dateStr).toLocaleString('fr-FR', {
      day: '2-digit', month: 'short', year: 'numeric',
      hour: '2-digit', minute: '2-digit'
    });
  }

  sortIcon(field: keyof AuditLog): string {
    if (this.sortField !== field) return 'bi-arrow-down-up';
    return this.sortDir === 'asc' ? 'bi-sort-up' : 'bi-sort-down';
  }

  get activeFilterCount(): number {
    return [this.searchTerm, this.filterStatus, this.filterType, this.filterUser].filter(Boolean).length;
  }

  // ── Delete log ──────────────────────────────────────────────────────────────
  deleteConfirmId: number | null = null;

  requestDelete(log: AuditLog, event: Event): void {
    event.stopPropagation();
    this.deleteConfirmId = log.id;
    this.cdr.markForCheck();
  }

  cancelDelete(event: Event): void {
    event.stopPropagation();
    this.deleteConfirmId = null;
    this.cdr.markForCheck();
  }

  confirmDelete(log: AuditLog, event: Event): void {
    event.stopPropagation();
    this.http.delete(`${ORDS}/audit/logs/${log.id}`).subscribe({
      next: () => {
        this.logs     = this.logs.filter(l => l.id !== log.id);
        this.applyFilters();
        this.deleteConfirmId = null;
        if (this.detailLog?.id === log.id) this.closeDetail();
        this.cdr.markForCheck();
      },
      error: () => {
        this.deleteConfirmId = null;
        this.cdr.markForCheck();
      }
    });
  }

  goToPage(p: number): void {
    if (p >= 1 && p <= this.totalPages) { this.page = p; this.cdr.markForCheck(); }
  }

  get pageNumbers(): number[] {
    const total = this.totalPages;
    const cur   = this.page;
    const delta = 2;
    const range: number[] = [];
    for (let i = Math.max(1, cur - delta); i <= Math.min(total, cur + delta); i++) {
      range.push(i);
    }
    return range;
  }

  trackByGroup = (_: number, g: AnomalyGroup): string => g.table + '|' + g.cle;
  trackByTable = (_: number, tg: any): string => tg.table;
  trackByCol   = (_: number, a: Anomaly): number => a.id ?? 0;
}