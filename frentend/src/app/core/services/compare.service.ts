import { Injectable } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable } from 'rxjs';

const ORDS = 'http://localhost:3000/v1';

@Injectable({ providedIn: 'root' })
export class CompareService {
  constructor(private http: HttpClient) {}

  /**
   * Single-table comparison.
   * Passes excluded columns as a comma-separated string to the backend.
   */
  compareTable(
    envSrc: string,
    envCbl: string,
    nomTable: string,
    userId: number,
    excludedCols: string = ''
  ): Observable<any> {
    return this.http.post<any>(`${ORDS}/audit/table`, {
      env_src:       envSrc,
      env_cbl:       envCbl,
      nom_table:     nomTable,
      user_id:       userId,
      excluded_cols: excludedCols
    });
  }

  /**
   * Full-schema comparison.
   * Passes excluded tables as a comma-separated string to the backend.
   */
  compareFull(
    envSrc: string,
    envCbl: string,
    userId: number,
    excludedTables: string = ''
  ): Observable<any> {
    return this.http.post<any>(`${ORDS}/audit/full`, {
      env_src:          envSrc,
      env_cbl:          envCbl,
      user_id:          userId,
      excluded_tables:  excludedTables
    });
  }

  /**
   * Fetch anomaly results for a given operation ID.
   */
  getAnomalies(opId: number): Observable<any> {
    return this.http.get<any>(`${ORDS}/audit/results/${opId}`, {
      responseType: 'json' as const
    });
  }

  /**
   * Fetch columns of a specific table from a specific environment.
   * Uses the `env` query param so the backend builds `ENV_LINK` dynamically.
   * e.g. GET /audit/columns/MY_TABLE?env=UAT  →  queries UAT_LINK
   */
  getTableColumns(env: string, tableName: string): Observable<any> {
    const params = new HttpParams().set('env', env);
    return this.http.get<any>(`${ORDS}/audit/columns/${tableName.toUpperCase()}`, {
      params,
      responseType: 'json' as const
    });
  }

  /**
   * Fetch the list of auditable tables from a specific environment.
   * Uses the `env` query param so the backend builds `ENV_LINK` dynamically.
   * e.g. GET /audit/tables?env=PROD  →  queries PROD_LINK
   */
  getAuditableTables(env: string): Observable<any> {
    const params = new HttpParams().set('env', env);
    return this.http.get<any>(`${ORDS}/audit/tables`, {
      params,
      responseType: 'json' as const
    });
  }
}
