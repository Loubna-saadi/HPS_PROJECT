import { ApplicationConfig } from '@angular/core';
import { provideRouter } from '@angular/router';
import { provideHttpClient, withFetch, withInterceptors } from '@angular/common/http'; // Ajoute withInterceptors
import { routes } from './app.routes';
import { provideClientHydration } from '@angular/platform-browser';
import { authInterceptor } from './core/interceptors/auth.interceptor'; // Importe ton interceptor

export const appConfig: ApplicationConfig = {
  providers: [
    provideRouter(routes),
    // On ajoute withInterceptors([authInterceptor]) ici
    provideHttpClient(withFetch(), withInterceptors([authInterceptor])), 
    provideClientHydration() 
  ]
};