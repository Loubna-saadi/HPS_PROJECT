import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';

@Injectable({ providedIn: 'root' })
export class ExportService {
  // MISE À JOUR : Utilise le nouveau chemin configuré dans ORDS
  private readonly API_URL = 'http://localhost:8080/ords/v1/data/export';

  constructor(private http: HttpClient) {}

  /**
   * Méthode générique pour récupérer le Blob depuis ORDS
   */
  private getFile(format: string, opId: number): Observable<Blob> {
    return this.http.get(`${this.API_URL}/${format}/${opId}`, { responseType: 'blob' });
  }

  // Téléchargement JSON
  downloadJson(opId: number): Observable<Blob> {
    return this.getFile('json', opId);
  }

  // Téléchargement CSV (Excel)
  downloadCsv(opId: number): Observable<Blob> {
    return this.getFile('csv', opId);
  }

  // Téléchargement XML
  downloadXml(opId: number): Observable<Blob> {
    return this.getFile('xml', opId);
  }

  // Téléchargement SQL (Scripts)
  downloadSql(opId: number): Observable<Blob> {
    return this.getFile('sql', opId);
  }
}