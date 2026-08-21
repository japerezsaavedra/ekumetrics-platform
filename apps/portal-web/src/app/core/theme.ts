import { Injectable, signal } from '@angular/core';

export type ThemeMode = 'light' | 'dark';

const STORAGE_KEY = 'eku-theme';

@Injectable({ providedIn: 'root' })
export class ThemeService {
  readonly mode = signal<ThemeMode>(this.readStored());

  constructor() {
    this.apply(this.mode());
  }

  toggle(): void {
    this.apply(this.mode() === 'light' ? 'dark' : 'light');
  }

  apply(mode: ThemeMode): void {
    this.mode.set(mode);
    const root = document.documentElement;
    root.classList.remove('eku-theme-light', 'eku-theme-dark');
    root.classList.add(`eku-theme-${mode}`);
    root.style.colorScheme = mode;
    localStorage.setItem(STORAGE_KEY, mode);
  }

  private readStored(): ThemeMode {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored === 'dark' ? 'dark' : 'light';
  }
}
