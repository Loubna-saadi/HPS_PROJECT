import { Component } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { CommonModule } from '@angular/common';

@Component({
  selector: 'app-home',
  standalone: true,
  imports: [CommonModule, RouterLink],
  templateUrl: './home.html',
  styleUrl: './home.css'
})
export class HomeComponent {
  constructor(private router: Router) {}

  handleAccess() {
    const user = localStorage.getItem('currentUser');
    if (user) {
      // Session active -> Direction Dashboard
      this.router.navigate(['/dashboard']);
    } else {
      // Pas de session -> Direction Login
      this.router.navigate(['/login']);
    }
  }
}