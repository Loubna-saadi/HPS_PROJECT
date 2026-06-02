import { Component, inject, ChangeDetectorRef, NgZone, OnInit, HostListener } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { Router } from '@angular/router';
import { CompareService } from '../../../core/services/compare.service';
import { AuthService } from '../../../core/services/auth';

const ORDS = 'http://localhost:3000/v1';

interface TableColumn {
  column_name: string;
  data_type:   string;
  nullable:    string;
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

interface AnomalyGroup {
  table:         string;
  cle:           string;
  columns:       Anomaly[];
  statusSummary: string;
  expanded:      boolean;
}

interface TableGroup {
  table:      string;
  groups:     AnomalyGroup[];
  collapsed:  boolean;
}

@Component({
  selector: 'app-comparison',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './comparison.html',
  styleUrls: ['./comparison.css']
})
export class ComparisonComponent implements OnInit {
  private compareService = inject(CompareService);
  private authService    = inject(AuthService);
  private cdr            = inject(ChangeDetectorRef);
  private ngZone         = inject(NgZone);
  private http           = inject(HttpClient);
  private router         = inject(Router);

  // ── Environments ──────────────────────────────────────────
  availableEnvs = ['DEV', 'DEV_VAL', 'PROD', 'UAT', 'SIT'];
  envSrc  = 'DEV';
  envCbl  = 'DEV_VAL';

  // ── Mode ──────────────────────────────────────────────────
  isFullScan = false;
  tableName  = '';
  loading    = false;
  lastOperationId: number | null = null;

  // ── Column exclusion ──────────────────────────────────────
  availableColumns:  TableColumn[] = [];
  filteredColumns:   TableColumn[] = [];
  columnSearch       = '';
  excludedColumns:   Set<string>   = new Set();
  columnsLoading     = false;
  showColumnDropdown = false;

  // ── Table exclusion ───────────────────────────────────────
  availableTables:  string[] = [];
  filteredTables:   string[] = [];
  tableSearch       = '';
  excludedTables:   Set<string> = new Set();
  tablesLoading     = false;
  showTableDropdown = false;

  // ── Data ──────────────────────────────────────────────────
  anomalies: Anomaly[]      = [];
  groups:    AnomalyGroup[] = [];
  tableGroups: TableGroup[] = [];

  // ── Selection ─────────────────────────────────────────────
  selectedGroups: Set<string> = new Set();
  selectAll = false;

  // ── Detail Drawer ─────────────────────────────────────────
  drawerOpen:  boolean      = false;
  drawerGroup: AnomalyGroup | null = null;
  drawerIndex: number       = -1;

  // ── Stats ─────────────────────────────────────────────────
  get stats() {
    const all = this.anomalies;
    return {
      identical:     all.filter(a => a.alerte_statut?.includes('IDENTIQUE')).length,
      different:     all.filter(a => a.alerte_statut?.includes('DIFFERENTE') || a.alerte_statut?.includes('NULL')).length,
      missingCible:  all.filter(a => a.alerte_statut?.includes('ABSENT_DANS_CIBLE')).length,
      missingSource: all.filter(a => a.alerte_statut?.includes('ABSENT_DANS_SOURCE')).length,
      total:         all.length,
      groups:        this.groups.length,
    };
  }

  get hasSelection(): boolean { return this.selectedGroups.size > 0; }

 get selectedAnomalies(): Anomaly[] {
  return this.anomalies.filter(a =>
    this.selectedGroups.has((a.nom_table ?? '') + '|' + this.formatCle(a.cle)));
}

  // ── Keyboard: Escape closes drawer, arrows navigate ───────
  @HostListener('document:keydown', ['$event'])
  onKeyDown(e: KeyboardEvent): void {
    if (!this.drawerOpen) return;
    if (e.key === 'Escape')     { this.closeDrawer(); }
    if (e.key === 'ArrowDown')  { e.preventDefault(); this.drawerNext(); }
    if (e.key === 'ArrowUp')    { e.preventDefault(); this.drawerPrev(); }
  }

  ngOnInit(): void {
    this.loadAvailableTables();
  }

  // ── Drawer controls ───────────────────────────────────────
  openDrawer(g: AnomalyGroup): void {
    this.drawerIndex = this.groups.indexOf(g);
    this.drawerGroup = g;
    this.drawerOpen  = true;
    document.body.classList.add('drawer-is-open');
  }

  closeDrawer(): void {
    this.drawerOpen = false;
    document.body.classList.remove('drawer-is-open');
    // Keep drawerGroup a moment so the close animation completes
    setTimeout(() => {
      if (!this.drawerOpen) this.drawerGroup = null;
    }, 300);
  }

  drawerNext(): void {
    if (this.drawerIndex < this.groups.length - 1) {
      this.drawerIndex++;
      this.drawerGroup = this.groups[this.drawerIndex];
    }
  }

  drawerPrev(): void {
    if (this.drawerIndex > 0) {
      this.drawerIndex--;
      this.drawerGroup = this.groups[this.drawerIndex];
    }
  }

  // ── Tables list ───────────────────────────────────────────
  loadAvailableTables(): void {
    this.tablesLoading = true;
    this.http.get<any>(`${ORDS}/audit/tables`, {
      params: { env: this.envSrc }, responseType: 'json' as const
    }).subscribe({
      next: (res) => {
        const raw = res.items ?? res;
        this.availableTables = Array.isArray(raw)
          ? raw.map((t: any) => t.table_name ?? t.TABLE_NAME) : [];
        this.filteredTables  = [...this.availableTables];
        this.tablesLoading   = false;
        this.cdr.markForCheck();
      },
      error: () => { this.tablesLoading = false; }
    });
  }

  // ── Columns ───────────────────────────────────────────────
  onTableNameChange(): void {
    const name = this.tableName.trim().toUpperCase();
    this.excludedColumns.clear();
    this.columnSearch = '';
    if (!name || name.length < 2) {
      this.availableColumns = []; this.filteredColumns = []; return;
    }
    this.columnsLoading = true;
    this.http.get<any>(`${ORDS}/audit/columns/${name}`, {
      params: { env: this.envSrc }, responseType: 'json' as const
    }).subscribe({
      next: (res) => {
        const raw = res.items ?? res;
        this.availableColumns = Array.isArray(raw)
          ? raw.map((c: any) => ({
              column_name: c.column_name ?? c.COLUMN_NAME,
              data_type:   c.data_type   ?? c.DATA_TYPE,
              nullable:    c.nullable    ?? c.NULLABLE,
            })) : [];
        this.filteredColumns  = [...this.availableColumns];
        this.columnsLoading   = false;
        this.cdr.markForCheck();
      },
      error: () => { this.columnsLoading = false; }
    });
  }

  onColumnSearch(): void {
    const term = this.columnSearch.trim().toLowerCase();
    this.filteredColumns = term
      ? this.availableColumns.filter(c =>
          c.column_name.toLowerCase().includes(term) || c.data_type.toLowerCase().includes(term))
      : [...this.availableColumns];
  }

  onTableSearch(): void {
    const term = this.tableSearch.trim().toLowerCase();
    this.filteredTables = term
      ? this.availableTables.filter(t => t.toLowerCase().includes(term))
      : [...this.availableTables];
  }

  // ── Exclusion ─────────────────────────────────────────────
  toggleColumnExclusion(col: string, event: Event): void {
    event.stopPropagation();
    this.excludedColumns.has(col) ? this.excludedColumns.delete(col) : this.excludedColumns.add(col);
  }
  toggleTableExclusion(tbl: string, event: Event): void {
    event.stopPropagation();
    this.excludedTables.has(tbl) ? this.excludedTables.delete(tbl) : this.excludedTables.add(tbl);
  }
  clearColumnExclusion(): void { this.excludedColumns.clear(); this.showColumnDropdown = false; }
  clearTableExclusion():  void { this.excludedTables.clear();  this.showTableDropdown  = false; }

  // ── Selection ─────────────────────────────────────────────
  groupKey(g: AnomalyGroup): string { return g.table + '|' + g.cle; }

  toggleGroup(g: AnomalyGroup): void {
    const k = this.groupKey(g);
    this.selectedGroups.has(k) ? this.selectedGroups.delete(k) : this.selectedGroups.add(k);
    this.selectAll = this.selectedGroups.size === this.groups.length;
  }

  toggleSelectAll(): void {
    this.selectAll = !this.selectAll;
    this.selectAll
      ? this.groups.forEach(g => this.selectedGroups.add(this.groupKey(g)))
      : this.selectedGroups.clear();
  }

  // ── Build table-level groups (full scan) ──────────────────
  private buildTableGroups(groups: AnomalyGroup[]): TableGroup[] {
    const map = new Map<string, AnomalyGroup[]>();
    for (const g of groups) {
      if (!map.has(g.table)) map.set(g.table, []);
      map.get(g.table)!.push(g);
    }
    return [...map.entries()].map(([table, grps]) => ({
      table, groups: grps, collapsed: false
    }));
  }

  toggleTableGroup(tg: TableGroup): void { tg.collapsed = !tg.collapsed; }

  trackByTable = (_: number, tg: TableGroup): string => tg.table;

  // ── Build groups ──────────────────────────────────────────
  private buildGroups(items: Anomaly[]): AnomalyGroup[] {
    const map = new Map<string, AnomalyGroup>();
   for (const a of items) {
  const formattedCle = this.formatCle(a.cle);

  const key = (a.nom_table ?? '') + '|' + formattedCle;

  if (!map.has(key)) {
    map.set(key, {
      table: a.nom_table ?? '',
      cle: formattedCle, // 👈 IMPORTANT: use formattedCle here
      columns: [],
      statusSummary: '',
      expanded: false
    });
  }

  map.get(key)!.columns.push(a);
}
    const order = ['ABSENT_DANS_CIBLE','ABSENT_DANS_SOURCE','VALEUR_NULL','VALEUR_DIFFERENTE'];
    for (const g of map.values()) {
      let worst = '';
      for (const rank of order) {
        if (g.columns.some(c => c.alerte_statut?.toUpperCase().includes(rank))) { worst = rank; break; }
      }
      g.statusSummary = worst;
    }
    return [...map.values()];
  }
formatCle(cle: any): string {
  if (!cle) return '';
  let s = typeof cle === 'string' ? cle.trim() : String(cle);
  try {
    // Step 1: strip outer single-quotes if present: '{ ... }' → { ... }
    if (s.startsWith("'") && s.endsWith("'")) {
      s = s.slice(1, -1).trim();
    }

    // Step 2: remove stray single-quote after opening brace or before closing brace
    s = s.replace(/^\{'/, '{')
         .replace(/'\}$/, '}');

    // Step 3: quote unquoted keys: {MIN_CARD_RANGE:"val"} → {"MIN_CARD_RANGE":"val"}
    s = s.replace(/\{([A-Z_][A-Z0-9_]*)\s*:/g, '{"$1":')
         .replace(/,\s*([A-Z_][A-Z0-9_]*)\s*:/g, ',"$1":');

    // Step 4: parse and join values
    const obj = JSON.parse(s);
    if (typeof obj === 'object' && obj !== null) {
      return Object.values(obj).join('-');
    }
    return String(obj);
  } catch {
    return String(cle);
  }
}
  // ── Export navigation ─────────────────────────────────────
  navigateToExport(): void {
    const rows = this.hasSelection
      ? this.selectedAnomalies
      : this.anomalies.filter(a => a.alerte_statut && !a.alerte_statut.includes('IDENTIQUE'));

    this.router.navigate(['/export'], {
      state: {
        operationId:    this.lastOperationId,
        anomalies:      rows,
        envSrc:         this.envSrc,
        envCbl:         this.envCbl,
        isSelection:    this.hasSelection,
        selectionCount: this.selectedGroups.size,
      }
    });
  }

  // ── Main compare ──────────────────────────────────────────
  startCompare(): void {
    const userId = this.authService.getUserId();
    if (!userId) { alert('Session expirée.'); return; }

    this.ngZone.run(() => {
      this.loading = true;
      this.anomalies = []; this.groups = [];
      this.selectedGroups.clear(); this.selectAll = false;
      this.lastOperationId = null;
      this.closeDrawer();
    });

    const observer = {
      next:  (res: any) => {
        const opId = res.operationId ?? res.ID ?? res.id;
        opId ? this.loadAnomalies(opId) : this.stopLoading();
      },
      error: (err: any) => { console.error(err); this.stopLoading(); }
    };

    if (this.isFullScan) {
      this.compareService.compareFull(
        this.envSrc, this.envCbl, userId, [...this.excludedTables].join(',')
      ).subscribe(observer);
    } else {
      this.compareService.compareTable(
        this.envSrc, this.envCbl, this.tableName.trim().toUpperCase(),
        userId, [...this.excludedColumns].join(',')
      ).subscribe(observer);
    }
  }

  loadAnomalies(opId: number): void {
    this.compareService.getAnomalies(opId).subscribe({
      next: (data: any) => {
        this.ngZone.run(() => {
          this.lastOperationId = opId;
          const rawItems: any[] = data?.items ?? data ?? [];
          this.anomalies = rawItems.map((item: any) => {
            const n: any = {};
            for (const k in item) {
              if (Object.prototype.hasOwnProperty.call(item, k)) n[k.toLowerCase()] = item[k];
            }
            return n as Anomaly;
          });
          const diffs = this.anomalies.filter(
            a => a.alerte_statut && !a.alerte_statut.includes('IDENTIQUE'));
          this.groups = this.buildGroups(diffs);
          this.tableGroups = this.buildTableGroups(this.groups);
          this.loading = false;
          this.cdr.markForCheck();
          this.cdr.detectChanges();
        });
      },
      error: (err: any) => { console.error('[compare] error:', err); this.stopLoading(); }
    });
  }

  private stopLoading(): void {
    this.ngZone.run(() => { this.loading = false; this.cdr.detectChanges(); });
  }

  // ── Status helpers ────────────────────────────────────────
  getStatusClass(statut: string): string {
    if (!statut) return 'badge-info';
    const s = statut.toUpperCase();
    if (s.includes('ABSENT_DANS_CIBLE'))  return 'badge-red';
    if (s.includes('ABSENT_DANS_SOURCE')) return 'badge-yellow';
    if (s.includes('NULL'))               return 'badge-purple';
    if (s.includes('DIFFERENTE'))         return 'badge-orange';
    return 'badge-info';
  }

  getGroupStatusClass(summary: string): string {
    if (summary.includes('ABSENT_DANS_CIBLE'))  return 'grp-red';
    if (summary.includes('ABSENT_DANS_SOURCE')) return 'grp-yellow';
    if (summary.includes('NULL'))               return 'grp-purple';
    if (summary.includes('DIFFERENTE'))         return 'grp-orange';
    return 'grp-info';
  }

  getGroupStatusLabel(summary: string): string {
    if (summary.includes('ABSENT_DANS_CIBLE'))  return 'Absent en cible';
    if (summary.includes('ABSENT_DANS_SOURCE')) return 'Absent en source';
    if (summary.includes('NULL'))               return 'Valeur NULL';
    if (summary.includes('DIFFERENTE'))         return 'Valeurs différentes';
    return summary;
  }

  trackByKey = (_: number, g: AnomalyGroup): string => g.table + '|' + g.cle;
  trackById  = (_: number, a: Anomaly):      number  => a.id ?? 0;
}