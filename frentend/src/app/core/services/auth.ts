import { Injectable, inject, PLATFORM_ID } from '@angular/core'; // Ajoute PLATFORM_ID
import { isPlatformBrowser } from '@angular/common'; // Ajoute isPlatformBrowser
import { HttpClient } from '@angular/common/http';
import { Router } from '@angular/router';
import { Observable, tap } from 'rxjs';

@Injectable({
  providedIn: 'root'
})
export class AuthService {
  private http = inject(HttpClient);
  private router = inject(Router);
  private platformId = inject(PLATFORM_ID); // Injecte l'ID de plateforme
  private baseUrl = 'http://localhost:3000/v1/auth';

  private storeSession(response: any): void {
    localStorage.setItem('token',       response.token);
    localStorage.setItem('role',        response.role);
    localStorage.setItem('username',    response.login);
    localStorage.setItem('nom',         response.nom || '');
    localStorage.setItem('currentUser', JSON.stringify(response));
  }

  signup(login: string, password: string, nom: string = ''): Observable<any> {
    return this.http.post<any>(`${this.baseUrl}/signup`, { login, password, nom }).pipe(
      tap(response => { if (isPlatformBrowser(this.platformId) && response) this.storeSession(response); })
    );
  }

  login(loginSaisi: string, mdpSaisi: string): Observable<any> {
    return this.http.post<any>(`${this.baseUrl}/login`, { login: loginSaisi, password: mdpSaisi }).pipe(
      tap(response => { if (isPlatformBrowser(this.platformId) && response) this.storeSession(response); })
    );
  }

  logout(): void {
    if (isPlatformBrowser(this.platformId)) {
      localStorage.clear();
    }
    this.router.navigate(['/login']);
  }

  isLoggedIn(): boolean {
    if (isPlatformBrowser(this.platformId)) {
      return !!localStorage.getItem('token');
    }
    return false;
  }

  getRole(): string | null {
    if (isPlatformBrowser(this.platformId)) {
      return localStorage.getItem('role');
    }
    return null;
  }

  getUsername(): string | null {
    if (isPlatformBrowser(this.platformId)) {
      return localStorage.getItem('username');
    }
    return null;
  }

  getDisplayName(): string | null {
    if (isPlatformBrowser(this.platformId)) {
      return localStorage.getItem('nom') || localStorage.getItem('username');
    }
    return null;
  }
getUserId(): number | null {
  if (isPlatformBrowser(this.platformId)) {
    const userJson = localStorage.getItem('currentUser');
    
    if (userJson) {
      try {
        const user = JSON.parse(userJson);
        console.log("Structure reçue d'Oracle :");
        console.table(user); // <--- Ceci va t'afficher un tableau clair dans la console

        // On teste TOUTES les clés possibles en majuscules et minuscules
        const id = user.id || user.ID || user.user_id || user.USER_ID || user.id_utilisateur || user.ID_UTILISATEUR;
        
        if (id !== undefined && id !== null) {
          return Number(id);
        }
      } catch (e) {
        console.error("Erreur de lecture du JSON utilisateur", e);
      }
    }
  }
  return null;
}

  

}