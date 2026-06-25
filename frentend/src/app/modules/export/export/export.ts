import { Component, OnInit, inject, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { HttpClient } from '@angular/common/http';
import { ExportService } from '../../../core/services/export.service';
import { AuthService } from '../../../core/services/auth';

const ORDS = 'http://localhost:3000/v1';

// ── Interfaces ───────────────────────────────────────────────────────────────

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

interface PkPair { col: string; val: string | null; }

interface OperationSummary {
  id:               number;
  date_operation:   string;
  source_env:       string;
  cible_env:        string;
  tables_impactees: number;
  nb_anomalies:     number;
  statut:           string;
}

export interface SimRecord {
  table:   string;
  key:     string;
  action:  'INSERT' | 'UPDATE' | 'DELETE_SKIPPED';
  status:  'ok' | 'error' | 'skipped';
  error:   string | null;
  before:  Record<string, string | null> | null;
  after:   Record<string, string | null> | null;
}

type ExportScope     = 'all' | 'absences' | 'differences' | 'nulls';
type RuleDirection   = string;   // stores the actual env name that acts as authority
type ScriptSaveState = 'idle' | 'saving' | 'saved' | 'error';
type SimState        = 'idle' | 'running' | 'done' | 'error';

// ── Component ────────────────────────────────────────────────────────────────

@Component({
  selector: 'app-export',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './export.html',
  styleUrls: ['./export.css']
})
export class ExportComponent implements OnInit {
  private router        = inject(Router);
  private http          = inject(HttpClient);
  private cdr           = inject(ChangeDetectorRef);
  private exportService = inject(ExportService);
  private authService   = inject(AuthService);

  // ── State ──────────────────────────────────────────────────────────────────
  operationId:  number | null = null;
  envSrc        = '';
  envCbl        = '';
  isFromCompare = false;

  // ── db_link names — read from ENVIRONNEMENT, never constructed by hand ─────
  dbLinkSrc    = '';    // e.g. "DEV_LINK"
  dbLinkCbl    = '';    // e.g. "DEVVAL_LINK"
  dbLinksReady = false;

  // ── Role ───────────────────────────────────────────────────────────────────
  get canEditScript(): boolean {
    const role = (this.authService as any).getRole?.() ?? '';
    return ['SUPERUSER', 'ADMIN'].includes(role.toUpperCase());
  }

  // ── Anomalies ──────────────────────────────────────────────────────────────
  allAnomalies:      Anomaly[] = [];
  filteredAnomalies: Anomaly[] = [];
  loadingAnomalies   = false;

  // ── Scope ──────────────────────────────────────────────────────────────────
  exportScope: ExportScope = 'all';

  // ── Operation picker ───────────────────────────────────────────────────────
  recentOperations:   OperationSummary[] = [];
  loadingOperations   = false;
  showOperationPicker = false;

  // ── Preview pagination ─────────────────────────────────────────────────────
  previewPage        = 1;
  readonly PAGE_SIZE = 8;

  // ── Script editor ──────────────────────────────────────────────────────────
  ruleDirection:       RuleDirection   = '';   // set to envSrc once loaded
  scriptContent:       string          = '';
  scriptSaveState:     ScriptSaveState = 'idle';
  scriptSavedId:       number | null   = null;
  scriptModified                       = false;
  serverScriptLoading                  = false;

  // ── Simulation ─────────────────────────────────────────────────────────────
  simState:        SimState    = 'idle';
  simRecords:      SimRecord[] = [];
  simError:        string      = '';
  simExpandedKeys: Set<string> = new Set();
  showSimPanel                 = false;
  simColHeaders:   string[]    = [];

  // ── Computed ───────────────────────────────────────────────────────────────
  get stats() {
    const a = this.allAnomalies;
    return {
      total:       a.length,
      absences:    a.filter(x => x.alerte_statut?.includes('ABSENT')).length,
      differences: a.filter(x => x.alerte_statut?.includes('DIFFERENTE')).length,
      nulls:       a.filter(x => x.alerte_statut?.includes('NULL')).length,
    };
  }

  get previewRows(): Anomaly[] {
    const s = (this.previewPage - 1) * this.PAGE_SIZE;
    return this.filteredAnomalies.slice(s, s + this.PAGE_SIZE);
  }

  get totalPages(): number {
    return Math.ceil(this.filteredAnomalies.length / this.PAGE_SIZE);
  }

  get paginationPages(): number[] {
    const t = this.totalPages;
    if (t <= 7) return Array.from({ length: t }, (_, i) => i + 1);
    const p = this.previewPage;
    if (p <= 4)     return [1, 2, 3, 4, 5, -1, t];
    if (p >= t - 3) return [1, -1, t - 4, t - 3, t - 2, t - 1, t];
    return [1, -1, p - 1, p, p + 1, -1, t];
  }

  get affectedTables(): string[] {
    return [...new Set(this.filteredAnomalies.map(a => a.nom_table))];
  }

  get isSourceAuthority(): boolean { return this.ruleDirection === this.envSrc; }

  get simSummary() {
    return {
      ok:      this.simRecords.filter(r => r.status === 'ok').length,
      errors:  this.simRecords.filter(r => r.status === 'error').length,
      skipped: this.simRecords.filter(r => r.status === 'skipped').length,
      inserts: this.simRecords.filter(r => r.action === 'INSERT' && r.status === 'ok').length,
      updates: this.simRecords.filter(r => r.action === 'UPDATE' && r.status === 'ok').length,
    };
  }

  minOf = Math.min;

  // ==========================================================================
  // DB_LINK RESOLUTION
  // Calls GET /audit/envlink?env=XXX which reads ENVIRONNEMENT.db_link
  // so we always get the exact stored value (e.g. DEVVAL_LINK not DEV_VAL_LINK)
  // ==========================================================================

  private getLink(env: string): Promise<string> {
    return this.http
      .get<{ env: string; db_link: string }>(`${ORDS}/audit/envlink`, {
        params: { env },
      })
      .toPromise()
      .then(res => {
        if (!res?.db_link) throw new Error(`No db_link for ${env}`);
        return res.db_link;
      })
      .catch(err => {
        console.warn(`[export] Could not resolve db_link for ${env}:`, err);
        return '';
      });
  }

  private loadDbLinks(): Promise<void> {
    if (!this.envSrc || !this.envCbl) return Promise.resolve();
    this.dbLinksReady = false;
    this.dbLinkSrc    = '';
    this.dbLinkCbl    = '';

    return Promise.all([
      this.getLink(this.envSrc),
      this.getLink(this.envCbl),
    ]).then(([src, cbl]) => {
      this.dbLinkSrc    = src;
      this.dbLinkCbl    = cbl;
      this.dbLinksReady = true;
      this.cdr.markForCheck();
    });
  }

  // ==========================================================================
  // JSON CLE HELPERS
  // ==========================================================================

  private normaliseCleJson(cle: any): Record<string, any> | null {
    if (!cle) return null;
    let s = typeof cle === 'string' ? cle.trim() : String(cle);
    try {
      if (s.startsWith("'") && s.endsWith("'")) { s = s.slice(1, -1).trim(); }
      s = s.replace(/^\{'/, '{').replace(/\'\}$/, '}');
      s = s.replace(/\{([A-Z_][A-Z0-9_]*)\s*:/g, '{"$1":')
           .replace(/,\s*([A-Z_][A-Z0-9_]*)\s*:/g, ',"$1":');
      const obj = JSON.parse(s);
      if (typeof obj === 'object' && obj !== null) return obj;
    } catch { /* fall through */ }
    return null;
  }

  // For the preview table value cells: absent-row JSON is too long for a cell —
  // show a column-count summary instead; normal values wrap at 120 chars.
  displayVal(val: string | null, typeDiff: string): string {
    if (val == null) return 'NULL';
    if (typeDiff === 'ROW') {
      try {
        let s = val.trim();
        if (s.startsWith("'") && s.endsWith("'")) s = s.slice(1, -1).trim();
        const obj = JSON.parse(s);
        if (obj && typeof obj === 'object') {
          const count = Object.keys(obj).length;
          return `(${count} colonnes — ligne complète)`;
        }
      } catch { /* fall through */ }
    }
    return val.length > 120 ? val.slice(0, 120) + '…' : val;
  }

  formatCle(cle: any): string {
    const obj = this.normaliseCleJson(cle);
    if (obj) {
      return Object.values(obj)
        .map((v: any) => {
          const str = String(v ?? '');
          return str.length > 20 ? str.slice(0, 20) + '…' : str;
        })
        .join('\n');
    }
    const s = typeof cle === 'string' ? cle.trim() : String(cle ?? '');
    return s.length > 20 ? s.slice(0, 20) + '…' : s;
  }

  formatCleFull(cle: any): string {
    const obj = this.normaliseCleJson(cle);
    if (obj) {
      return Object.entries(obj)
        .map(([k, v]) => `${k}: ${v ?? 'NULL'}`)
        .join('\n');
    }
    return typeof cle === 'string' ? cle.trim() : String(cle ?? '');
  }

  parseCle(cle: string): PkPair[] {
    if (!cle) return [];
    let trimmed = cle.trim();

    if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
      trimmed = trimmed.slice(1, -1).trim();
    }
    if (trimmed.startsWith(`{'"`)) {
      trimmed = '{' + trimmed.slice(2);
    }
    if (trimmed.startsWith('{')) {
      try {
        const obj = JSON.parse(trimmed);
        const pairs: PkPair[] = Object.entries(obj).map(([col, val]) => ({
          col,
          val: val !== null && val !== undefined ? String(val) : null,
        }));
        if (pairs.length > 0) return pairs;
      } catch { /* fall through */ }
    }

    return [{ col: '<PK>', val: trimmed }];
  }

  buildWhereClause(cle: string): string {
    const pairs = this.parseCle(cle);
    if (!pairs.length) return '/* key unknown — fill in manually */';

    if (pairs.length === 1 && pairs[0].col === '<PK>') {
      const escaped = (pairs[0].val ?? '').replace(/\*\//g, '* /');
      return `/* ⚠  Could not resolve PK column names. Raw key: ${escaped}\n       Replace this comment with the correct WHERE condition. */`;
    }

    return pairs
      .map(p =>
        p.val !== null
          ? `${p.col} = '${p.val.replace(/'/g, "''")}'`
          : `${p.col} IS NULL`
      )
      .join('\n    AND ');
  }

  formatCleLabel(cle: string): string {
    const pairs = this.parseCle(cle);
    if (pairs.length === 1 && pairs[0].col === '<PK>') return pairs[0].val ?? cle;
    return pairs.map(p => `${p.col}=${p.val ?? 'NULL'}`).join(', ');
  }

  // ==========================================================================
  // LIFECYCLE
  // ==========================================================================

  ngOnInit(): void {
    const nav   = this.router.getCurrentNavigation();
    const state = (nav?.extras?.state ?? history.state) as any;

    if (state?.operationId && state?.anomalies?.length) {
      this.operationId   = state.operationId;
      this.envSrc        = state.envSrc  ?? '';
      this.envCbl        = state.envCbl  ?? '';
      this.ruleDirection = this.envSrc;   // default authority = source env
      this.isFromCompare = true;
      this.allAnomalies  = (state.anomalies as Anomaly[])
        .filter((a: Anomaly) => !(a.alerte_statut ?? '').includes('IDENTIQUE'));
      // Load real db_link names first, then build the script
      this.loadDbLinks().then(() => this.applyScope());
    } else {
      this.loadRecentOperations(true);
    }
  }

  // ── Operation history ──────────────────────────────────────────────────────
  loadRecentOperations(autoSelectFirst = false): void {
    this.loadingOperations = true;
    this.http.get<any>(`${ORDS}/audit/operations/recent`, { params: { userId: 21 } })
      .subscribe({
        next: (res) => {
          this.recentOperations  = (res.items ?? res) as OperationSummary[];
          this.loadingOperations = false;
          if (autoSelectFirst && this.recentOperations.length > 0) {
            this.selectOperation(this.recentOperations[0]);
          } else {
            this.showOperationPicker = true;
          }
          this.cdr.markForCheck();
        },
        error: () => { this.loadingOperations = false; }
      });
  }

  selectOperation(op: OperationSummary): void {
    this.operationId         = op.id;
    this.envSrc              = op.source_env;
    this.envCbl              = op.cible_env;
    this.ruleDirection       = op.source_env;  // default authority = source env
    this.isFromCompare       = false;
    this.showOperationPicker = false;
    this.previewPage         = 1;
    this.scriptSaveState     = 'idle';
    this.scriptSavedId       = null;
    this.scriptModified      = false;
    this.dbLinksReady        = false;
    this.dbLinkSrc           = '';
    this.dbLinkCbl           = '';
    this.resetSim();
    // Load real db_link names first, then load anomalies (which triggers regenerateScript)
    this.loadDbLinks().then(() => this.loadAnomaliesForOp(op.id));
  }

  loadAnomaliesForOp(opId: number): void {
    this.loadingAnomalies  = true;
    this.allAnomalies      = [];
    this.filteredAnomalies = [];
    this.scriptContent     = '';

    this.http.get<any>(`${ORDS}/audit/results/${opId}`).subscribe({
      next: (res) => {
        const raw: any[] = res.items ?? res ?? [];
        this.allAnomalies = raw
          .filter((x: any) => !(x.alerte_statut ?? '').includes('IDENTIQUE'))
          .map((item: any) => {
            const n: any = {};
            for (const k in item) {
              if (Object.prototype.hasOwnProperty.call(item, k)) n[k.toLowerCase()] = item[k];
            }
            return n as Anomaly;
          });
        this.loadingAnomalies = false;
        this.applyScope();
        this.cdr.markForCheck();
      },
      error: () => { this.loadingAnomalies = false; }
    });
  }

  // ── Scope ──────────────────────────────────────────────────────────────────
  applyScope(): void {
    this.previewPage = 1;
    switch (this.exportScope) {
      case 'absences':
        this.filteredAnomalies = this.allAnomalies.filter(a => a.alerte_statut?.includes('ABSENT')); break;
      case 'differences':
        this.filteredAnomalies = this.allAnomalies.filter(a => a.alerte_statut?.includes('DIFFERENTE')); break;
      case 'nulls':
        this.filteredAnomalies = this.allAnomalies.filter(a => a.alerte_statut?.includes('NULL')); break;
      default:
        this.filteredAnomalies = [...this.allAnomalies];
    }
    if (this.canEditScript && !this.scriptModified) {
      this.regenerateScript();
    }
  }

  // ==========================================================================
  // SCRIPT GENERATION
  // Uses this.dbLinkSrc / this.dbLinkCbl — resolved from ENVIRONNEMENT
  // so the link name is always correct (e.g. DEVVAL_LINK not DEV_VAL_LINK)
  // ==========================================================================

  private parseRowJson(raw: string | null): Record<string, string | null> | null {
    if (!raw) return null;
    try {
      let s = raw.trim();
      if (s.startsWith("'") && s.endsWith("'")) s = s.slice(1, -1).trim();
      const obj = JSON.parse(s);
      if (obj && typeof obj === 'object' && !Array.isArray(obj)) return obj as Record<string, string | null>;
    } catch { /* fall through */ }
    return null;
  }

  private toOracleLiteral(val: string | null | undefined): string {
    if (val == null) return 'NULL';
    const s = String(val);
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(s)) {
      const dt = s.replace('T', ' ').replace(/\.\d+Z?$/, '').substring(0, 19);
      return `TO_DATE('${dt}','YYYY-MM-DD HH24:MI:SS')`;
    }
    return `'${s.replace(/'/g, "''")}'`;
  }

  regenerateScript(): void {
    this.scriptModified  = false;
    this.scriptSaveState = 'idle';
    this.scriptSavedId   = null;

    const rows       = this.filteredAnomalies;
    const srcIsAuth  = this.isSourceAuthority;

    // Authority env = values that WIN
    const authEnv   = srcIsAuth ? this.envSrc : this.envCbl;
    // Target env    = env that gets corrected
    const targetEnv = srcIsAuth ? this.envCbl : this.envSrc;

    // Real db_link names from ENVIRONNEMENT
    const authLink   = srcIsAuth ? this.dbLinkSrc : this.dbLinkCbl;
    const targetLink = srcIsAuth ? this.dbLinkCbl : this.dbLinkSrc;

    // Warn in header if links not resolved yet
    const linkWarn = (!authLink || !targetLink)
      ? `-- ⚠  WARNING: db_link names could not be resolved.\n`
      + `-- Verify GET /audit/envlink?env=${authEnv} and ?env=${targetEnv}\n`
      + `-- Fix the @??? placeholders before running.\n`
      : '';

    const lines: string[] = [
      `-- ================================================================`,
      `-- Script de correction — Opération #${this.operationId}`,
      `-- Généré le         : ${new Date().toLocaleString('fr-FR')}`,
      `-- Autorité (gagne)  : ${authEnv}   → @${authLink || '???'}`,
      `-- Cible  (corrigée) : ${targetEnv} → @${targetLink || '???'}`,
      `-- Périmètre         : ${this.exportScope} — ${rows.length} écart(s)`,
      `--`,
      `-- HOW TO RUN: Connect to any schema with access to both db_links,`,
      `-- then run as-is. No substitution needed.`,
      `-- ⚠  Always back up before running on PROD.`,
      `-- ================================================================`,
      ...(linkWarn ? [linkWarn] : []),
      ``,
      `-- Connectivity check (run these first):`,
      `-- SELECT 1 FROM DUAL@${authLink || '???'};`,
      `-- SELECT 1 FROM DUAL@${targetLink || '???'};`,
      ``,
    ];

    // Group by (table, cle) — one SQL block per record
    const grouped = new Map<string, Anomaly[]>();
    for (const r of rows) {
      const k = r.nom_table + '||' + r.cle;
      if (!grouped.has(k)) grouped.set(k, []);
      grouped.get(k)!.push(r);
    }

    for (const [, cols] of grouped) {
      const first       = cols[0];
      const table       = first.nom_table;
      const cle         = first.cle;
      const status      = first.alerte_statut?.toUpperCase() ?? '';
      const whereClause = this.buildWhereClause(cle);
      const cleLabel    = this.formatCleLabel(cle);

      // INSERT: row missing in target ────────────────────────────────────────
      if (
        (status.includes('ABSENT_DANS_CIBLE')  && srcIsAuth) ||
        (status.includes('ABSENT_DANS_SOURCE') && !srcIsAuth)
      ) {
        const rawJson   = status.includes('ABSENT_DANS_CIBLE') ? first.valeur_source : first.valeur_cible;
        const parsedRow = this.parseRowJson(rawJson);
        if (parsedRow) {
          const cols    = Object.keys(parsedRow);
          const colList = cols.map(c => c.toUpperCase()).join(', ');
          const valList = cols.map(c => this.toOracleLiteral(parsedRow[c])).join(',\n    ');
          lines.push(
            `-- ➕ INSERT — ligne absente dans ${targetEnv}`,
            `-- Clé   : ${cleLabel}`,
            `-- Table : ${table}`,
            `INSERT INTO ${table}@${targetLink} (${colList})`,
            `VALUES (`,
            `    ${valList}`,
            `);`,
            ``,
          );
        } else {
          lines.push(
            `-- ➕ INSERT — ligne absente dans ${targetEnv}`,
            `-- Clé   : ${cleLabel}`,
            `-- Table : ${table}`,
            `INSERT INTO ${table}@${targetLink}`,
            `  SELECT *`,
            `  FROM   ${table}@${authLink}`,
            `  WHERE  ${whereClause};`,
            ``,
          );
        }
        continue;
      }

      // DELETE (commented — manual validation required) ──────────────────────
      if (
        (status.includes('ABSENT_DANS_CIBLE')  && !srcIsAuth) ||
        (status.includes('ABSENT_DANS_SOURCE') && srcIsAuth)
      ) {
        lines.push(
          `-- 🗑  REVIEW DELETE — ligne présente uniquement dans ${targetEnv}`,
          `-- Clé   : ${cleLabel}`,
          `-- Table : ${table}`,
          `-- Décommenter après validation manuelle :`,
          `-- DELETE FROM ${table}@${targetLink}`,
          `-- WHERE  ${whereClause};`,
          ``,
        );
        continue;
      }

      // UPDATE: only columns that actually differ (exclude ABSENT and IDENTIQUE)
      const updateCols = cols.filter(c => {
        const s = (c.alerte_statut ?? '').toUpperCase();
        return !s.includes('ABSENT') && s !== 'IDENTIQUE';
      });
      if (!updateCols.length) continue;

      const setClauses = updateCols.map(c => {
        const rawVal = srcIsAuth ? c.valeur_source : c.valeur_cible;
        return `    ${c.type_difference} = ${this.toOracleLiteral(rawVal)}`;
      }).join(',\n');

      lines.push(
        `-- ✏️  UPDATE — différence de valeur(s)`,
        `-- Clé   : ${cleLabel}`,
        `-- Table : ${table}`,
        `-- Cols  : ${updateCols.map(c => c.type_difference).join(', ')}`,
        `UPDATE ${table}@${targetLink}`,
        `SET`,
        `${setClauses}`,
        `WHERE  ${whereClause};`,
        ``,
      );
    }

    lines.push(`COMMIT;`);
    this.scriptContent = lines.join('\n');
    this.cdr.markForCheck();
  }

  // ==========================================================================
  // SCRIPT GENERATION — SERVER SIDE
  // ==========================================================================

  generateScriptServerSide(): void {
    if (!this.operationId) return;
    this.serverScriptLoading = true;

    this.http.post<any>(`${ORDS}/audit/generate-script`, {
      operation_id: this.operationId,
      direction:    this.isSourceAuthority ? 'source' : 'cible',
    }).subscribe({
      next: (res) => {
        this.scriptContent       = res.script ?? '';
        this.scriptSavedId       = res.id     ?? null;
        this.scriptSaveState     = 'saved';
        this.scriptModified      = false;
        this.serverScriptLoading = false;
        this.cdr.markForCheck();
      },
      error: () => {
        this.serverScriptLoading = false;
        alert('Erreur génération côté serveur.');
        this.cdr.markForCheck();
      }
    });
  }

  // ==========================================================================
  // SIMULATION
  // ==========================================================================

  runSimulation(): void {
    if (!this.operationId) return;
    this.simState        = 'running';
    this.simRecords      = [];
    this.simError        = '';
    this.showSimPanel    = true;
    this.simExpandedKeys = new Set();
    this.cdr.markForCheck();

    this.http.post<SimRecord[]>(`${ORDS}/audit/simulate-script`, {
      operation_id: this.operationId,
      direction:    this.isSourceAuthority ? 'source' : 'cible',
    }).subscribe({
      next: (records) => {
        this.simRecords    = records ?? [];
        this.simColHeaders = this.extractColHeaders(this.simRecords);
        this.simState      = 'done';
        this.cdr.markForCheck();
      },
      error: (err) => {
        this.simError = err?.error?.error ?? 'Erreur serveur inconnue';
        this.simState = 'error';
        this.cdr.markForCheck();
      }
    });
  }

  resetSim(): void {
    this.simState        = 'idle';
    this.simRecords      = [];
    this.simError        = '';
    this.showSimPanel    = false;
    this.simExpandedKeys = new Set();
    this.simColHeaders   = [];
  }

  toggleSimRow(key: string): void {
    this.simExpandedKeys.has(key)
      ? this.simExpandedKeys.delete(key)
      : this.simExpandedKeys.add(key);
  }

  isSimRowExpanded(key: string): boolean {
    return this.simExpandedKeys.has(key);
  }

  private extractColHeaders(records: SimRecord[]): string[] {
    const cols = new Set<string>();
    for (const r of records) {
      if (r.before) Object.keys(r.before).forEach(k => cols.add(k));
      if (r.after)  Object.keys(r.after).forEach(k => cols.add(k));
    }
    return [...cols];
  }

  changedCols(rec: SimRecord): string[] {
    if (!rec.before || !rec.after) return Object.keys(rec.after ?? rec.before ?? {});
    return Object.keys(rec.after).filter(
      col => String(rec.before![col] ?? '') !== String(rec.after![col] ?? '')
    );
  }

  simRecordKey(rec: SimRecord): string { return rec.table + '|' + rec.key; }

  simActionClass(action: string): string {
    if (action === 'INSERT')         return 'sim-action-insert';
    if (action === 'UPDATE')         return 'sim-action-update';
    if (action === 'DELETE_SKIPPED') return 'sim-action-skip';
    return '';
  }

  simActionIcon(action: string): string {
    if (action === 'INSERT')         return 'bi-plus-circle-fill';
    if (action === 'UPDATE')         return 'bi-pencil-fill';
    if (action === 'DELETE_SKIPPED') return 'bi-slash-circle';
    return 'bi-question';
  }

  // ── Direction / script editor ──────────────────────────────────────────────
  onRuleDirectionChange(dir: RuleDirection): void {
    if (this.ruleDirection === dir) return;
    if (this.scriptModified) {
      if (!confirm('Changer la règle va réinitialiser le script. Continuer ?')) return;
    }
    this.ruleDirection  = dir;
    this.scriptModified = false;
    this.resetSim();
    this.regenerateScript();
  }

  onScriptInput(): void {
    this.scriptModified  = true;
    this.scriptSaveState = 'idle';
  }

  resetScript(): void {
    if (this.scriptModified &&
        !confirm('Réinitialiser le script ? Modifications perdues.')) return;
    this.scriptModified = false;
    this.regenerateScript();
  }

  saveScript(): void {
    if (!this.operationId || !this.scriptContent.trim()) return;
    this.scriptSaveState = 'saving';

    this.http.post<any>(`${ORDS}/audit/scripts`, {
      operation_id: this.operationId,
      contenu_sql:  this.scriptContent,
      direction:    this.isSourceAuthority ? 'source' : 'cible',
      scope:        this.exportScope,
      statut:       'SCRIPT_GENERE',
    }).subscribe({
      next: (res) => {
        this.scriptSavedId   = res?.id ?? res?.ID ?? null;
        this.scriptSaveState = 'saved';
        this.scriptModified  = false;
        this.cdr.markForCheck();
      },
      error: () => {
        this.scriptSaveState = 'error';
        this.cdr.markForCheck();
      }
    });
  }

  // ── Status helpers ─────────────────────────────────────────────────────────
  getStatusClass(s: string): string {
    if (!s) return 'badge-info';
    const u = s.toUpperCase();
    if (u.includes('ABSENT_DANS_CIBLE'))  return 'badge-red';
    if (u.includes('ABSENT_DANS_SOURCE')) return 'badge-yellow';
    if (u.includes('NULL'))               return 'badge-purple';
    if (u.includes('DIFFERENTE'))         return 'badge-orange';
    return 'badge-info';
  }

  getStatusLabel(s: string): string {
    if (!s) return '—';
    if (s.includes('ABSENT_DANS_CIBLE'))  return 'Absent cible';
    if (s.includes('ABSENT_DANS_SOURCE')) return 'Absent source';
    if (s.includes('NULL'))               return 'Valeur NULL';
    if (s.includes('DIFFERENTE'))         return 'Différente';
    return s;
  }

  // ── Exports ────────────────────────────────────────────────────────────────
  onExportCsv(): void {
    if (!this.operationId) return;
    if (this.isFromCompare) {
      const headers = ['CLE_JSON','NOM_TABLE','COLONNE','VALEUR_SOURCE','VALEUR_CIBLE','STATUT'];
      const csv = [
        headers.join(','),
        ...this.filteredAnomalies.map(r =>
          [r.cle, r.nom_table, r.type_difference,
           r.valeur_source ?? 'NULL', r.valeur_cible ?? 'NULL', r.alerte_statut]
            .map(v => `"${String(v ?? '').replace(/"/g, '""')}"`)
            .join(',')
        )
      ].join('\n');
      this.triggerDownload(new Blob([csv], { type: 'text/csv;charset=utf-8;' }),
        `audit_op${this.operationId}_${this.exportScope}.csv`);
    } else {
      this.exportService.downloadCsv(this.operationId).subscribe({
        next: (b) => this.triggerDownload(b, `audit_${this.operationId}.csv`),
        error: () => alert('Erreur export CSV')
      });
    }
  }

  onExportJson(): void {
    if (!this.operationId) return;
    if (this.isFromCompare) {
      const payload = {
        operationId: this.operationId, envSource: this.envSrc, envCible: this.envCbl,
        scope: this.exportScope, exportedAt: new Date().toISOString(),
        count: this.filteredAnomalies.length, anomalies: this.filteredAnomalies,
      };
      this.triggerDownload(
        new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8;' }),
        `audit_op${this.operationId}_${this.exportScope}.json`
      );
    } else {
      this.exportService.downloadJson(this.operationId).subscribe({
        next: (b) => this.triggerDownload(b, `audit_${this.operationId}.json`),
        error: () => alert('Erreur export JSON')
      });
    }
  }

  onExportXml(): void {
    if (!this.operationId) return;
    if (this.isFromCompare) {
      const esc = (v: any) => String(v ?? '')
        .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
      const lines = [
        `<?xml version="1.0" encoding="UTF-8"?>`,
        `<AuditExport operationId="${this.operationId}" envSource="${esc(this.envSrc)}"` +
          ` envCible="${esc(this.envCbl)}" exportedAt="${new Date().toISOString()}"` +
          ` count="${this.filteredAnomalies.length}">`,
        ...this.filteredAnomalies.map(r =>
          `  <Anomaly>\n    <CleJson>${esc(r.cle)}</CleJson>\n    <Table>${esc(r.nom_table)}</Table>\n` +
          `    <Colonne>${esc(r.type_difference)}</Colonne>\n` +
          `    <ValeurSource>${esc(r.valeur_source ?? 'NULL')}</ValeurSource>\n` +
          `    <ValeurCible>${esc(r.valeur_cible ?? 'NULL')}</ValeurCible>\n` +
          `    <Statut>${esc(r.alerte_statut)}</Statut>\n  </Anomaly>`
        ),
        `</AuditExport>`,
      ];
      this.triggerDownload(
        new Blob([lines.join('\n')], { type: 'application/xml;charset=utf-8;' }),
        `audit_op${this.operationId}_${this.exportScope}.xml`
      );
    } else {
      this.exportService.downloadXml(this.operationId).subscribe({
        next: (b) => this.triggerDownload(b, `audit_${this.operationId}.xml`),
        error: () => alert('Erreur export XML')
      });
    }
  }

  onExportSql(): void {
    if (!this.scriptContent.trim()) return;
    this.triggerDownload(
      new Blob([this.scriptContent], { type: 'text/plain;charset=utf-8;' }),
      `correction_op${this.operationId}_${this.ruleDirection}_wins.sql`
    );
  }

  private triggerDownload(blob: Blob, fileName: string): void {
    const url = window.URL.createObjectURL(blob);
    const a   = document.createElement('a');
    a.href = url; a.download = fileName;
    document.body.appendChild(a); a.click();
    window.URL.revokeObjectURL(url);
    document.body.removeChild(a);
  }

  goBack(): void { this.router.navigate(['/compare']); }
  trackById  = (_: number, a: Anomaly):    number => a.id ?? 0;
  trackByKey = (_: number, r: SimRecord): string => this.simRecordKey(r);
}