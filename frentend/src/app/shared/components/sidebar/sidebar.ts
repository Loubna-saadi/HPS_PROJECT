import { Component, inject } from '@angular/core';
import { RouterLink, RouterLinkActive } from '@angular/router';
import { AuthService } from '../../../core/services/auth';
import { CommonModule } from '@angular/common';

@Component({
  selector: 'app-sidebar',
  standalone: true,
  imports: [RouterLink, RouterLinkActive, CommonModule],
  templateUrl: './sidebar.html',
  styleUrl: './sidebar.css',
})
export class SidebarComponent {
  private authService = inject(AuthService);

  get isLoggedIn():   boolean         { return this.authService.isLoggedIn(); }
  get displayName():  string | null   { return this.authService.getDisplayName(); }
  get userRole():     string | null   { return this.authService.getRole(); }

  onLogout() { this.authService.logout(); }
}