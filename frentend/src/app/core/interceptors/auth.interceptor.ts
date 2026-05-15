import { inject, PLATFORM_ID } from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import { HttpInterceptorFn } from '@angular/common/http';

export const authInterceptor: HttpInterceptorFn = (req, next) => {
  // 1. On injecte l'identifiant de la plateforme (Navigateur vs Serveur)
  const platformId = inject(PLATFORM_ID);

  // 2. On vérifie si on est bien dans le navigateur avant d'utiliser localStorage
  if (isPlatformBrowser(platformId)) {
    const token = localStorage.getItem('token');

    // 3. Si le token existe, on clone et on ajoute le Header
    if (token) {
      const authReq = req.clone({
        setHeaders: {
          Authorization: `Bearer ${token}`
        }
      });
      return next(authReq);
    }
  }

  // 4. Si on est sur le serveur ou sans token, on laisse passer la requête telle quelle
  return next(req);
};