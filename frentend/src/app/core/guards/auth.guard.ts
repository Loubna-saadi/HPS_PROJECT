import { inject } from '@angular/core';
import { Router, CanActivateFn } from '@angular/router';

export const authGuard: CanActivateFn = (route, state) => {
  const router = inject(Router);
  const token = localStorage.getItem('token');

  if (token) {
    return true; // L'utilisateur a un token, on le laisse passer
  } else {
    // Pas de token ? On le renvoie au login
    router.navigate(['/login']);
    return false;
  }
};