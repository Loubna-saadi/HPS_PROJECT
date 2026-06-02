import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';

@Injectable({
  providedIn: 'root'
})
export class AuditService {
  // Remplace 'ton_schema' par le nom de ton schéma Oracle
  private apiUrl = 'http://localhost:3000/v1/audit';

  constructor(private http: HttpClient) { }

  // Récupère les stats des cards
  getDashboardStats(): Observable<any> {
    return this.http.get(`${this.apiUrl}/dashboard-stats`);
  }
}