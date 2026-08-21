import { Injectable, signal } from '@angular/core';

@Injectable({ providedIn: 'root' })
export class KioskService {
  readonly active = signal(false);

  constructor() {
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && this.active()) {
        this.exit();
      }
    });
    document.addEventListener('fullscreenchange', () => {
      if (!document.fullscreenElement && this.active()) {
        this.exit();
        return;
      }
      if (document.fullscreenElement) {
        requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));
      }
    });
  }

  toggle(): void {
    if (this.active()) {
      this.exit();
      return;
    }
    this.enter();
  }

  enter(): void {
    this.active.set(true);
    document.documentElement.classList.add('eku-kiosk');
    void document.documentElement.requestFullscreen?.().catch(() => undefined);
    requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));
  }

  exit(): void {
    this.active.set(false);
    document.documentElement.classList.remove('eku-kiosk');
    if (document.fullscreenElement) {
      void document.exitFullscreen().catch(() => undefined);
    }
  }
}
