import {
  ChangeDetectionStrategy,
  Component,
  ViewEncapsulation,
  computed,
  input,
} from '@angular/core';
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
  readonly text = input('');

  protected readonly html = computed((): string => {
    const parsed = marked.parse(this.prepare(this.text()), {
      async: false,
      gfm: true,
      breaks: true,
    });
    const raw = typeof parsed === 'string' ? parsed : '';
    return DOMPurify.sanitize(raw, { USE_PROFILES: { html: true } });
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
