import { ChangeDetectionStrategy, Component } from '@angular/core';
import { MatIcon } from '@angular/material/icon';
import { MatMenu, MatMenuTrigger } from '@angular/material/menu';
import { MatTooltip } from '@angular/material/tooltip';

type TimeAdvice = {
  range: string;
  refresh: string;
  purpose: string;
  recommended?: boolean;
};

@Component({
  selector: 'app-home-time-help',
  imports: [MatIcon, MatMenu, MatMenuTrigger, MatTooltip],
  templateUrl: './home-time-help.html',
  styleUrl: './home-time-help.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class HomeTimeHelpComponent {
  protected readonly advice: TimeAdvice[] = [
    {
      range: '1 o 5 min',
      refresh: 'Live 1s',
      purpose: 'Ver algo que pasa ahora: un pico, una prueba',
    },
    { range: '15 min', refresh: '30 s', purpose: 'Vigilancia del día a día', recommended: true },
    { range: '1 hora', refresh: '30 s', purpose: 'Tendencia corta' },
    { range: '3 a 6 h', refresh: '1 min', purpose: 'Turno o incidente reciente' },
    { range: '12 a 24 h', refresh: '5 min', purpose: 'Revisión del día' },
    { range: '7 días', refresh: '5 min', purpose: 'Capacidad y comparación' },
  ];
}
