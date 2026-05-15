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
  private apiUrl = 'http://localhost:8080/ords/v1/auth/login';

 login(loginSaisi: string, mdpSaisi: string): Observable<any> {
  const body = { login: loginSaisi, password: mdpSaisi };
  return this.http.post<any>(this.apiUrl, body).pipe(
    tap(response => {
      if (isPlatformBrowser(this.platformId) && response) {
        // On stocke TOUT ce qu'on voit sur Postman
        localStorage.setItem('token', response.token);
        localStorage.setItem('role', response.role);
        localStorage.setItem('username', response.login); // Postman dit "login"
        localStorage.setItem('currentUser', JSON.stringify(response)); 
        
        console.log("Données stockées avec succès :", response);
      }
    })
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