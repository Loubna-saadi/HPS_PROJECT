import {
  Component, OnInit, ChangeDetectionStrategy,
  ChangeDetectorRef, HostListener
} from '@angular/core';
import { CommonModule }  from '@angular/common';
import { FormsModule }   from '@angular/forms';
import { HttpClient }    from '@angular/common/http';
import { AuthService }   from '../../core/services/auth';

const ORDS = 'http://localhost:3000/v1';

// ── Interfaces ────────────────────────────────────────────────────────────────

export interface ConnectionProfile {
  id:             number | null;
  env_code:       string;
  url_api:        string | null;
  db_link:        string | null;
  host:           string;
  port:           number;
  service_name:   string;
  db_username:    string;
  db_password:    string;
  description:    string;
  last_test_ok:   number | null;   // 1 = ok, 0 = fail, null = never tested
  last_tested_at: string | null;
  created_at:     string | null;
  updated_at:     string | null;
  link_exists:    number;          // 1 = DB link exists in all_db_links
}

interface TestResult {
  env_code:   string;
  ok:         number;
  message:    string;
  latency_ms: number;
}

type FormMode  = 'create' | 'edit';
type SaveState = 'idle' | 'saving' | 'saved' | 'error';
type TestState = 'idle' | 'testing' | 'ok' | 'fail';

const ALL_ENVS = ['DEV', 'DEV_VAL', 'MASTER_VAL', 'UAT', 'SIT', 'PROD'];

const EMPTY_FORM = (): Partial<ConnectionProfile> => ({
  env_code:     '',
  host:         '',
  port:         1521,
  service_name: '',
  db_username:  '',
  db_password:  '',
  description:  '',
});

// ── Component ─────────────────────────────────────────────────────────────────

@Component({
  selector: 'app-connection-profiles',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './connection-profiles.html',
  styleUrls:   ['./connection-profiles.css'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ConnectionProfilesComponent implements OnInit {

  // ── Auth ──────────────────────────────────────────────────────────────────
  role   = '';
  userId = 0;

  get canEdit(): boolean {
    return ['SUPERUSER', 'ADMIN'].includes(this.role.toUpperCase());
  }

  // ── List state ────────────────────────────────────────────────────────────
  profiles:    ConnectionProfile[] = [];
  loading      = true;
  loadError    = '';

  // ── Derived: envs without a profile yet ──────────────────────────────────
  get configuredEnvCodes(): string[] {
    return this.profiles.map(p => p.env_code);
  }
  get unconfiguredEnvs(): string[] {
    return ALL_ENVS.filter(e => !this.configuredEnvCodes.includes(e));
  }

  // ── Form / drawer ─────────────────────────────────────────────────────────
  drawerOpen  = false;
  formMode:   FormMode  = 'create';
  form:       Partial<ConnectionProfile> = EMPTY_FORM();
  showPass    = false;
  saveState:    SaveState = 'idle';
  saveError     = '';
  linksCreated: { from: string; to: string; link: string }[] = [];
  linksFailed:  { from: string; to: string; error: string }[] = [];
  envSelectChoice = '';

  // ── Per-card test state ───────────────────────────────────────────────────
  testStates:  Map<string, TestState>  = new Map();
  testResults: Map<string, TestResult> = new Map();

  // ── Delete confirm ────────────────────────────────────────────────────────
  deleteTarget: ConnectionProfile | null = null;
  showDeleteConfirm = false;
  deleting = false;

  constructor(
    private http:        HttpClient,
    private cdr:         ChangeDetectorRef,
    private authService: AuthService,
  ) {}

  @HostListener('document:keydown', ['$event'])
  onKey(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      if (this.showDeleteConfirm) { this.cancelDelete(); return; }
      if (this.drawerOpen)        { this.closeDrawer();  return; }
    }
  }

  ngOnInit(): void {
    this.role   = this.authService.getRole()   ?? 'USER';
    this.userId = this.authService.getUserId() ?? 0;
    this.loadProfiles();
  }

  // ── Load ──────────────────────────────────────────────────────────────────
  loadProfiles(): void {
    this.loading   = true;
    this.loadError = '';
    this.http.get<any>(`${ORDS}/audit/connection-profiles`).subscribe({
      next: (res) => {
        const raw: any[] = res.items ?? (Array.isArray(res) ? res : []);
        this.profiles = raw.map(item => this.normalise(item));
        this.loading  = false;
        this.cdr.markForCheck();
      },
      error: (err) => {
        this.loadError = err?.error?.error ?? err?.message ?? 'Erreur de chargement';
        this.loading   = false;
        this.cdr.markForCheck();
      }
    });
  }

  private normalise(item: any): ConnectionProfile {
    const n: any = {};
    for (const k in item) {
      if (Object.prototype.hasOwnProperty.call(item, k)) n[k.toLowerCase()] = item[k];
    }
    return {
      id:             n['id']             ?? null,
      env_code:       n['env_code']       ?? '',
      url_api:        n['url_api']        ?? null,
      db_link:        n['db_link']        ?? null,
      host:           n['host']           ?? '',
      port:           n['port']           ?? 1521,
      service_name:   n['service_name']   ?? '',
      db_username:    n['db_username']    ?? '',
      db_password:    n['db_password']    ?? '••••••••',
      description:    n['description']    ?? '',
      last_test_ok:   n['last_test_ok']   ?? null,
      last_tested_at: n['last_tested_at'] ?? null,
      created_at:     n['created_at']     ?? null,
      updated_at:     n['updated_at']     ?? null,
      link_exists:    n['link_exists']    ?? 0,
    };
  }

  // ── Drawer open / close ───────────────────────────────────────────────────
  openCreate(envCode?: string): void {
    this.formMode        = 'create';
    this.form            = { ...EMPTY_FORM(), env_code: envCode ?? '' };
    this.envSelectChoice = envCode ?? '';
    this.showPass        = false;
    this.saveState       = 'idle';
    this.saveError       = '';
    this.drawerOpen      = true;
    document.body.classList.add('cp-drawer-open');
    this.cdr.markForCheck();
  }

  openEdit(p: ConnectionProfile): void {
    if (!this.canEdit) return;
    this.formMode  = 'edit';
    this.form      = { ...p, db_password: '' };  // blank out — user must re-enter to change
    this.showPass  = false;
    this.saveState = 'idle';
    this.saveError = '';
    this.drawerOpen = true;
    document.body.classList.add('cp-drawer-open');
    this.cdr.markForCheck();
  }

  closeDrawer(): void {
    this.drawerOpen = false;
    document.body.classList.remove('cp-drawer-open');
    this.cdr.markForCheck();
  }

  // ── Save ──────────────────────────────────────────────────────────────────
  save(): void {
    if (!this.formValid) return;
    this.saveState = 'saving';
    this.saveError = '';
    this.cdr.markForCheck();

    const body = {
      env_code:     this.form.env_code,
      host:         this.form.host,
      port:         this.form.port ?? 1521,
      service_name: this.form.service_name,
      db_username:  this.form.db_username,
      db_password:  this.form.db_password || '••••••••',   // sentinel = keep existing
      description:  this.form.description ?? '',
      user_id:      this.userId,
    };

    this.http.post<any>(`${ORDS}/audit/connection-profiles`, body).subscribe({
      next: (res) => {
        this.saveState    = res.success ? 'saved' : 'error';
        this.linksCreated = res.links_created ?? [];
        this.linksFailed  = res.links_failed  ?? [];
        if (!res.success) {
          this.saveError = res.link_result ?? 'Profil sauvegardé mais le lien DB a échoué.';
        }
        this.cdr.markForCheck();
        if (res.success) {
          setTimeout(() => { this.closeDrawer(); this.loadProfiles(); }, 1500);
        }
      },
      error: (err) => {
        this.saveState = 'error';
        this.saveError = err?.error?.error ?? err?.message ?? 'Erreur serveur';
        this.cdr.markForCheck();
      }
    });
  }

  get formValid(): boolean {
    const f = this.form;
    return !!(f.env_code && f.host?.trim() && f.service_name?.trim()
              && f.db_username?.trim()
              && (this.formMode === 'edit' || f.db_password?.trim()));
  }

  // ── Test connection ───────────────────────────────────────────────────────
  testConnection(envCode: string): void {
    this.testStates.set(envCode, 'testing');
    this.cdr.markForCheck();

    this.http.post<TestResult>(`${ORDS}/audit/connection-profiles/test`, { env_code: envCode })
      .subscribe({
        next: (res) => {
          this.testResults.set(envCode, res);
          this.testStates.set(envCode, res.ok === 1 ? 'ok' : 'fail');
          // Refresh the profile card's last_test_ok badge
          const p = this.profiles.find(x => x.env_code === envCode);
          if (p) {
            p.last_test_ok   = res.ok;
            p.last_tested_at = new Date().toISOString();
          }
          this.cdr.markForCheck();
        },
        error: (err) => {
          const errMsg = err?.error?.error ?? err?.message ?? 'Erreur de connexion';
          this.testResults.set(envCode, {
            env_code: envCode, ok: 0, message: errMsg, latency_ms: 0
          });
          this.testStates.set(envCode, 'fail');
          this.cdr.markForCheck();
        }
      });
  }

  getTestState(envCode: string): TestState {
    return this.testStates.get(envCode) ?? 'idle';
  }

  getTestResult(envCode: string): TestResult | null {
    return this.testResults.get(envCode) ?? null;
  }

  // ── Delete ────────────────────────────────────────────────────────────────
  requestDelete(p: ConnectionProfile): void {
    this.deleteTarget     = p;
    this.showDeleteConfirm = true;
    this.cdr.markForCheck();
  }

  cancelDelete(): void {
    this.deleteTarget      = null;
    this.showDeleteConfirm = false;
    this.cdr.markForCheck();
  }

  confirmDelete(): void {
    if (!this.deleteTarget) return;
    this.deleting = true;
    this.http.delete(`${ORDS}/audit/connection-profiles/${this.deleteTarget.env_code}`).subscribe({
      next: () => {
        this.deleting          = false;
        this.showDeleteConfirm = false;
        this.deleteTarget      = null;
        this.loadProfiles();
        this.cdr.markForCheck();
      },
      error: () => {
        this.deleting = false;
        this.cdr.markForCheck();
      }
    });
  }

  // ── Helpers ───────────────────────────────────────────────────────────────
  availableEnvsForForm(): string[] {
    if (this.formMode === 'edit') return ALL_ENVS;
    return this.unconfiguredEnvs;
  }

  // Known envs for the select: standard list + any custom envs already saved
  knownEnvsForDatalist(): string[] {
    const custom = this.profiles
      .map(p => p.env_code)
      .filter(e => !ALL_ENVS.includes(e));
    return [...ALL_ENVS, ...custom];
  }

  // Called when the select changes
  onEnvSelectChange(val: string): void {
    if (val !== '__custom__') {
      this.form.env_code = val;
    } else {
      this.form.env_code = '';
    }
    this.cdr.markForCheck();
  }

  // Force uppercase as the user types in the free-text input
  onEnvInput(event: Event): void {
    const input = event.target as HTMLInputElement;
    const upper = input.value.toUpperCase().replace(/[^A-Z0-9_]/g, '');
    this.form.env_code = upper;
    input.value        = upper;
    this.cdr.markForCheck();
  }

  envColor(code: string): string {
    const map: Record<string, string> = {
      DEV:        '#3b82f6',
      DEV_VAL:    '#8b5cf6',
      MASTER_VAL: '#0ea5e9',
      UAT:        '#f59e0b',
      SIT:        '#10b981',
      PROD:       '#ef4444',
    };
    return map[code] ?? '#64748b';
  }

  envLabel(code: string): string {
    const map: Record<string, string> = {
      DEV:        'Development',
      DEV_VAL:    'Dev Validation',
      MASTER_VAL: 'Master Validation',
      UAT:        'User Acceptance',
      SIT:        'System Integration',
      PROD:       'Production',
    };
    return map[code] ?? code;
  }

  formatDate(d: string | null): string {
    if (!d) return '—';
    return new Date(d).toLocaleString('fr-FR', {
      day: '2-digit', month: 'short', year: 'numeric',
      hour: '2-digit', minute: '2-digit'
    });
  }

  trackByEnv = (_: number, p: ConnectionProfile): string => p.env_code;
  trackByStr = (_: number, s: string): string => s;
}