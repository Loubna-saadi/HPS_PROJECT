import { Component, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router, RouterModule } from '@angular/router';
import { HttpErrorResponse } from '@angular/common/http';
import { AuthService } from '../../../core/services/auth';

@Component({
  selector: 'app-login',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterModule],
  templateUrl: './login.html',
  styleUrl: './login.css'
})
export class LoginComponent {
  loginData    = { login: '', password: '' };
  errorMessage = '';
  loading      = false;
  showPw       = false;

  constructor(
    private authService: AuthService,
    private router: Router,
    private cdr: ChangeDetectorRef,
  ) {}

  onSubmit() {
    this.errorMessage = '';
    this.loading      = true;
    this.cdr.detectChanges();

    this.authService.login(this.loginData.login, this.loginData.password).subscribe({
      next: () => {
        this.loading = false;
        this.cdr.detectChanges();
        this.router.navigate(['/dashboard']);
      },
      error: (err: HttpErrorResponse) => {
        this.loading = false;
        if (err.status === 0) {
          this.errorMessage = 'Serveur inaccessible. Vérifiez que le backend est démarré.';
        } else if (err.status === 401) {
          this.errorMessage = 'Login ou mot de passe incorrect.';
        } else if (err.status === 400) {
          this.errorMessage = err.error?.error ?? 'Requête invalide.';
        } else {
          this.errorMessage = err.error?.error ?? `Erreur serveur (${err.status}).`;
        }
        this.cdr.detectChanges();
      }
    });
  }
}