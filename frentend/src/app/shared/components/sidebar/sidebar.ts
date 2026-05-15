import { Component, inject, OnInit, PLATFORM_ID } from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
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
export class SidebarComponent implements OnInit {
  private authService = inject(AuthService);
  private platformId = inject(PLATFORM_ID);

  userName: string | null = '';
  userRole: string | null = '';

  ngOnInit() {
    // On ne récupère les infos que si on est dans le navigateur
    if (isPlatformBrowser(this.platformId)) {
      this.userName = this.authService.getUsername();
      this.userRole = this.authService.getRole();
    }
  }

  onLogout() {
    this.authService.logout();
  }
}