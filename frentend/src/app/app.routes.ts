import { Routes } from '@angular/router';

import { DashboardComponent } from './modules/dashboard/dashboard/dashboard';
import { ComparisonComponent } from './modules/comparison/comparison/comparison';
import { ExportComponent } from './modules/export/export/export';
import { ImportComponent } from './modules/import/import/import';
import { LoginComponent } from './modules/auth/login/login';
import { SignupComponent } from './modules/auth/signup/signup';
import { HomeComponent } from './modules/home/home';
import { AuditLogsComponent } from './modules/audit-logs/audit-logs';
import { ConnectionProfilesComponent } from './modules/connection-profiles/connection-profiles';

export const routes: Routes = [
  { path: 'home', component: HomeComponent },
  { path: 'login', component: LoginComponent },
  { path: 'signup', component: SignupComponent },
  { path: 'dashboard', component: DashboardComponent },
  { path: 'export', component: ExportComponent },
  { path: 'compare', component: ComparisonComponent  },
  { path: 'audit', component: AuditLogsComponent },
   { path: 'connection-profiles', component: ConnectionProfilesComponent },
  { path: '', redirectTo: 'home', pathMatch: 'full' }, // Par défaut -> Home
  { path: '**', redirectTo: 'home' }
];