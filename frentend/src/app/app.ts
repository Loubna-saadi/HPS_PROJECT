import { Component } from '@angular/core';
import { RouterOutlet, Router, NavigationEnd } from '@angular/router';
import { SidebarComponent } from './shared/components/sidebar/sidebar'; 
import { CommonModule } from '@angular/common'; // <--- TRÈS IMPORTANT
import { filter } from 'rxjs';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [RouterOutlet, SidebarComponent, CommonModule], // Assure-toi que CommonModule est là
  templateUrl: './app.html',
  styleUrl: './app.css'
})
export class App {
  showSidebar = false; // Par défaut, on cache

  constructor(private router: Router) {
    this.router.events.pipe(
      filter(event => event instanceof NavigationEnd)
    ).subscribe((event: any) => {
      this.updateSidebarVisibility(event.urlAfterRedirects);
    });
  }

private updateSidebarVisibility(url: string) {
  // Liste des routes où la sidebar DOIT être cachée
  const hiddenRoutes = ['/login', '/home', '/'];
  
  // On vérifie si l'URL actuelle (ou l'URL après redirection) est dans la liste
  // .some() permet de vérifier si l'un des éléments de la liste est présent dans l'URL
  this.showSidebar = !hiddenRoutes.some(route => url === route || url.includes('/login') || url.includes('/home'));
  
  console.log("URL actuelle:", url, "Afficher Sidebar:", this.showSidebar);
}
}