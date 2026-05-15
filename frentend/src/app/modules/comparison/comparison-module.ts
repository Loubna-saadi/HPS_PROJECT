import { NgModule } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ComparisonComponent } from './comparison/comparison'; // Ton composant

@NgModule({
  declarations: [
    // VIDE : On ne déclare plus un composant Standalone ici
  ],
  imports: [
    CommonModule,
    FormsModule,
    ComparisonComponent // ON L'IMPORTE ICI (car il est standalone)
  ],
  exports: [
    ComparisonComponent // Optionnel : si tu l'utilises dans d'autres modules
  ]
})
export class ComparisonModule { }