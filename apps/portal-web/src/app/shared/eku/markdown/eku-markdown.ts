import {
  ChangeDetectionStrategy,
  Component,
  ViewEncapsulation,
  computed,
  inject,
  input,
} from '@angular/core';
import { DomSanitizer, type SafeHtml } from '@angular/platform-browser';
import DOMPurify from 'dompurify';
import { marked } from 'marked';

@Component({
  selector: 'eku-markdown',
  templateUrl: './eku-markdown.html',
  styleUrl: './eku-markdown.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.None,
})
export class EkuMarkdownComponent {
  private readonly sanitizer = inject(DomSanitizer);
  readonly text = input('');

  protected readonly html = computed((): SafeHtml => {
    const parsed = marked.parse(this.prepare(this.text()), {
      async: false,
      gfm: true,
      breaks: true,
    });
    const raw = typeof parsed === 'string' ? parsed : '';
    const clean = DOMPurify.sanitize(raw, { USE_PROFILES: { html: true } });
    return this.sanitizer.bypassSecurityTrustHtml(clean);
  });

  private prepare(text: string): string {
    let value = text.trim();
    const fenced = value.match(/^```(?:markdown|md|gfm)?\s*\n([\s\S]*?)\n```$/i);
    if (fenced?.[1]) {
      value = fenced[1].trim();
    }
    return value.replace(/([^\n|])\n(\|[^\n]+\|)\s*\n/g, '$1\n\n$2\n');
  }
}
