import { Component } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router, RouterModule } from '@angular/router';
import { AuthService } from '../../../core/services/auth';

@Component({
  selector: 'app-signup',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterModule],
  templateUrl: './signup.html',
  styleUrl: './signup.css'
})
export class SignupComponent {
  signupData = { login: '', password: '', confirmPassword: '', nom: '' };
  errorMessage = '';
  loading = false;

  constructor(private authService: AuthService, private router: Router) {}

  onSubmit() {
    this.errorMessage = '';

    if (this.signupData.password !== this.signupData.confirmPassword) {
      this.errorMessage = 'Les mots de passe ne correspondent pas.';
      return;
    }
    if (this.signupData.password.length < 4) {
      this.errorMessage = 'Le mot de passe doit contenir au moins 4 caractères.';
      return;
    }

    this.loading = true;
    this.authService.signup(
      this.signupData.login,
      this.signupData.password,
      this.signupData.nom
    ).subscribe({
      next: () => {
        this.router.navigate(['/dashboard']);
      },
      error: (err) => {
        this.loading = false;
        this.errorMessage = err?.error?.error || 'Erreur lors de la création du compte.';
      }
    });
  }
}
