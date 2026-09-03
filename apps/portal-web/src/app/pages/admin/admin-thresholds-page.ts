import { HttpClient } from '@angular/common/http';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { map, startWith } from 'rxjs';
import { API_BASE_URL } from '../../core/api';
import { TenantService } from '../../core/tenant';
import { EkuErrorStateComponent } from '../../shared/eku/error-state/eku-error-state';
import { EkuPageHeaderComponent } from '../../shared/eku/page-header/eku-page-header';

type Thresholds = {
  availabilityWarn: number;
  availabilityCrit: number;
  errorBudgetWarn: number;
  errorBudgetCrit: number;
  latencyWarn: number;
  latencyCrit: number;
  freshnessWarn: number;
  freshnessCrit: number;
  saturationWarn: number;
  saturationCrit: number;
  cpuWarn: number;
  cpuCrit: number;
  memWarn: number;
  memCrit: number;
  diskWarn: number;
  diskCrit: number;
  netWarn: number;
  netCrit: number;
  errorsWarn: number;
  errorsCrit: number;
  p95Warn: number;
  p95Crit: number;
};

type Field = keyof Thresholds;
type Metric = {
  title: string;
  hint: string;
  unit: string;
  warn: Field;
  crit: Field;
  scale: number;
  inputMax: number;
  step: number;
  mode: 'upto' | 'drop';
};

const PCT = Validators.min(0);
const rate = [Validators.required, PCT, Validators.max(1000)];

@Component({
  selector: 'app-admin-thresholds-page',
  imports: [ReactiveFormsModule, RouterLink, EkuPageHeaderComponent, EkuErrorStateComponent],
  templateUrl: './admin-thresholds-page.html',
  styleUrl: './admin-thresholds-page.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AdminThresholdsPage {
  private readonly http = inject(HttpClient);
  private readonly fb = inject(FormBuilder);
  private readonly tenants = inject(TenantService);
  private readonly route = inject(ActivatedRoute);

  protected readonly scope = toSignal(
    this.route.paramMap.pipe(
      map((params) => {
        const raw = params.get('scope');
        if (raw === 'plataforma') return 'platform' as const;
        if (raw === 'agentes') return 'agents' as const;
        return null;
      }),
    ),
    { initialValue: null },
  );
  protected readonly tenantName = computed(
    () => this.tenants.current()?.name || this.tenants.slug() || 'este tenant',
  );
  protected readonly agentCount = computed(() => this.tenants.current()?._count?.agents ?? 0);
  protected readonly title = computed(() => {
    if (this.scope() === 'platform') return 'E-Platform';
    if (this.scope() === 'agents') return `Agentes · ${this.tenantName()}`;
    return 'Umbrales';
  });
  protected readonly subtitle = computed(() => {
    if (this.scope() === 'platform') return 'Host de control, SLO y API.';
    if (this.scope() === 'agents') return `Hosts conectados de ${this.tenantName()}.`;
    return 'Elija el alcance: plataforma o agentes.';
  });
  protected readonly visibleGroups = computed(() =>
    this.scope() === 'agents' ? this.groups.filter((group) => group.title === 'Host') : this.groups,
  );
  protected readonly error = signal<string | null>(null);
  protected readonly saved = signal(false);
  protected readonly loading = signal(false);
  protected readonly form = this.fb.nonNullable.group({
    availabilityWarn: [1, [Validators.required, PCT, Validators.max(50)]],
    availabilityCrit: [5, [Validators.required, PCT, Validators.max(50)]],
    errorBudgetWarn: [50, [Validators.required, PCT, Validators.max(200)]],
    errorBudgetCrit: [100, [Validators.required, PCT, Validators.max(200)]],
    latencyWarn: [5, [Validators.required, PCT, Validators.max(50)]],
    latencyCrit: [15, [Validators.required, PCT, Validators.max(50)]],
    freshnessWarn: [1, [Validators.required, PCT, Validators.max(50)]],
    freshnessCrit: [5, [Validators.required, PCT, Validators.max(50)]],
    saturationWarn: [80, [Validators.required, PCT, Validators.max(200)]],
    saturationCrit: [100, [Validators.required, PCT, Validators.max(200)]],
    cpuWarn: [70, [Validators.required, PCT, Validators.max(100)]],
    cpuCrit: [90, [Validators.required, PCT, Validators.max(100)]],
    memWarn: [80, [Validators.required, PCT, Validators.max(100)]],
    memCrit: [90, [Validators.required, PCT, Validators.max(100)]],
    diskWarn: [70, [Validators.required, PCT, Validators.max(100)]],
    diskCrit: [85, [Validators.required, PCT, Validators.max(100)]],
    netWarn: [0.1, rate],
    netCrit: [1, rate],
    errorsWarn: [1, [Validators.required, PCT, Validators.max(50)]],
    errorsCrit: [5, [Validators.required, PCT, Validators.max(50)]],
    p95Warn: [500, [Validators.required, PCT, Validators.max(30000)]],
    p95Crit: [1000, [Validators.required, PCT, Validators.max(30000)]],
  });
  protected readonly draft = toSignal(this.form.valueChanges.pipe(startWith(this.form.getRawValue())), {
    initialValue: this.form.getRawValue(),
  });
  protected readonly groups: Array<{ title: string; metrics: Metric[] }> = [
    {
      title: 'SLO',
      metrics: [
        {
          title: 'Disponibilidad',
          hint: 'Cuánto puede bajar del 100 % antes de cambiar de color.',
          unit: '%',
          warn: 'availabilityWarn',
          crit: 'availabilityCrit',
          scale: 50,
          inputMax: 50,
          step: 0.1,
          mode: 'drop',
        },
        {
          title: 'Error budget',
          hint: 'Cuánto del presupuesto de error (0,1 %) se está gastando.',
          unit: '%',
          warn: 'errorBudgetWarn',
          crit: 'errorBudgetCrit',
          scale: 200,
          inputMax: 200,
          step: 1,
          mode: 'upto',
        },
        {
          title: 'Latencia SLO',
          hint: 'Peticiones que se salen del objetivo de 500 ms.',
          unit: '%',
          warn: 'latencyWarn',
          crit: 'latencyCrit',
          scale: 50,
          inputMax: 50,
          step: 0.1,
          mode: 'drop',
        },
        {
          title: 'Agentes al día',
          hint: 'Cuánto puede bajar la frescura de agentes.',
          unit: '%',
          warn: 'freshnessWarn',
          crit: 'freshnessCrit',
          scale: 50,
          inputMax: 50,
          step: 0.1,
          mode: 'drop',
        },
        {
          title: 'Saturación',
          hint: 'Lo peor entre cola de CPU, memoria y disco.',
          unit: '%',
          warn: 'saturationWarn',
          crit: 'saturationCrit',
          scale: 200,
          inputMax: 200,
          step: 1,
          mode: 'upto',
        },
      ],
    },
    {
      title: 'Host',
      metrics: [
        {
          title: 'CPU',
          hint: 'Uso de CPU del host.',
          unit: '%',
          warn: 'cpuWarn',
          crit: 'cpuCrit',
          scale: 100,
          inputMax: 100,
          step: 1,
          mode: 'upto',
        },
        {
          title: 'Memoria',
          hint: 'RAM ocupada del host.',
          unit: '%',
          warn: 'memWarn',
          crit: 'memCrit',
          scale: 100,
          inputMax: 100,
          step: 1,
          mode: 'upto',
        },
        {
          title: 'Disco',
          hint: 'Espacio usado en el disco del host.',
          unit: '%',
          warn: 'diskWarn',
          crit: 'diskCrit',
          scale: 100,
          inputMax: 100,
          step: 1,
          mode: 'upto',
        },
        {
          title: 'Red',
          hint: 'Errores más descartes por segundo.',
          unit: '/s',
          warn: 'netWarn',
          crit: 'netCrit',
          scale: 5,
          inputMax: 1000,
          step: 0.1,
          mode: 'upto',
        },
      ],
    },
    {
      title: 'API',
      metrics: [
        {
          title: 'Errores 5xx',
          hint: 'Porcentaje de respuestas 5xx.',
          unit: '%',
          warn: 'errorsWarn',
          crit: 'errorsCrit',
          scale: 50,
          inputMax: 50,
          step: 0.1,
          mode: 'drop',
        },
        {
          title: 'Latencia p95',
          hint: 'El 95 % de las peticiones tarda menos que este valor.',
          unit: 'ms',
          warn: 'p95Warn',
          crit: 'p95Crit',
          scale: 5000,
          inputMax: 30000,
          step: 50,
          mode: 'upto',
        },
      ],
    },
  ];

  constructor() {
    effect(() => {
      this.tenants.slug();
      const scope = this.scope();
      if (!scope) {
        return;
      }
      untracked(() => this.load(scope));
    });
  }

  protected fieldInvalid(name: Field): boolean {
    const control = this.form.controls[name];
    return control.invalid && (control.touched || control.dirty);
  }

  protected pairInvalid(metric: Metric): boolean {
    const warn = this.form.controls[metric.warn];
    const crit = this.form.controls[metric.crit];
    return (
      Number(warn.value) > Number(crit.value) &&
      (warn.touched || warn.dirty || crit.touched || crit.dirty)
    );
  }

  protected band(metric: Metric): {
    ok: number;
    warn: number;
    crit: number;
    label: string;
    okLabel: string;
    warnLabel: string;
    critLabel: string;
  } {
    const draft = this.draft();
    const warn = Math.max(0, Number(draft[metric.warn] ?? 0));
    const crit = Math.max(warn, Number(draft[metric.crit] ?? 0));
    const scale = Math.max(metric.scale, crit, 0.001);
    const ok = Math.min(scale, warn);
    const mid = Math.min(scale, Math.max(0, crit - warn));
    const rest = Math.max(0.001, scale - crit);
    const unit = metric.unit;
    const okLabel = `Normal 0–${this.fmt(warn, unit)}`;
    const warnLabel = `Aviso ${this.fmt(warn, unit)}–${this.fmt(crit, unit)}`;
    const critLabel = `Crítico ≥ ${this.fmt(crit, unit)}`;
    return {
      ok,
      warn: mid,
      crit: rest,
      label: `${okLabel}. ${warnLabel}. ${critLabel}.`,
      okLabel,
      warnLabel,
      critLabel,
    };
  }

  protected submit(): void {
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }
    const broken = this.visibleGroups().some((group) =>
      group.metrics.some((metric) => Number(this.form.controls[metric.warn].value) > Number(this.form.controls[metric.crit].value)),
    );
    if (broken) {
      this.form.markAllAsTouched();
      this.error.set('El aviso no puede superar el crítico.');
      return;
    }
    this.loading.set(true);
    this.error.set(null);
    this.saved.set(false);
    this.http
      .put<Thresholds>(`${API_BASE_URL}/v1/platform/thresholds`, this.toApi(), {
        params: { scope: this.scope() ?? 'agents' },
      })
      .subscribe({
      next: (value) => {
        this.apply(value);
        this.loading.set(false);
        this.saved.set(true);
      },
      error: (err: { error?: { message?: string } }) => {
        this.loading.set(false);
        this.error.set(err.error?.message ?? 'No se pudieron guardar los umbrales.');
      },
    });
  }

  private fmt(value: number, unit: string): string {
    const digits = value >= 10 || Number.isInteger(value) ? 0 : 1;
    return `${value.toFixed(digits)} ${unit}`.trim();
  }

  private load(scope: 'platform' | 'agents'): void {
    this.saved.set(false);
    this.http.get<Thresholds>(`${API_BASE_URL}/v1/platform/thresholds`, { params: { scope } }).subscribe({
      next: (value) => {
        this.apply(value);
        this.error.set(null);
      },
      error: (err: { error?: { message?: string } }) => {
        this.error.set(err.error?.message ?? 'No se pudieron leer los umbrales.');
      },
    });
  }

  private apply(value: Thresholds): void {
    this.form.patchValue({
      availabilityWarn: value.availabilityWarn * 100,
      availabilityCrit: value.availabilityCrit * 100,
      errorBudgetWarn: value.errorBudgetWarn * 100,
      errorBudgetCrit: value.errorBudgetCrit * 100,
      latencyWarn: value.latencyWarn * 100,
      latencyCrit: value.latencyCrit * 100,
      freshnessWarn: value.freshnessWarn * 100,
      freshnessCrit: value.freshnessCrit * 100,
      saturationWarn: value.saturationWarn * 100,
      saturationCrit: value.saturationCrit * 100,
      cpuWarn: value.cpuWarn * 100,
      cpuCrit: value.cpuCrit * 100,
      memWarn: value.memWarn * 100,
      memCrit: value.memCrit * 100,
      diskWarn: value.diskWarn * 100,
      diskCrit: value.diskCrit * 100,
      netWarn: value.netWarn,
      netCrit: value.netCrit,
      errorsWarn: value.errorsWarn * 100,
      errorsCrit: value.errorsCrit * 100,
      p95Warn: value.p95Warn * 1000,
      p95Crit: value.p95Crit * 1000,
    });
  }

  private toApi(): Thresholds {
    const v = this.form.getRawValue();
    return {
      availabilityWarn: v.availabilityWarn / 100,
      availabilityCrit: v.availabilityCrit / 100,
      errorBudgetWarn: v.errorBudgetWarn / 100,
      errorBudgetCrit: v.errorBudgetCrit / 100,
      latencyWarn: v.latencyWarn / 100,
      latencyCrit: v.latencyCrit / 100,
      freshnessWarn: v.freshnessWarn / 100,
      freshnessCrit: v.freshnessCrit / 100,
      saturationWarn: v.saturationWarn / 100,
      saturationCrit: v.saturationCrit / 100,
      cpuWarn: v.cpuWarn / 100,
      cpuCrit: v.cpuCrit / 100,
      memWarn: v.memWarn / 100,
      memCrit: v.memCrit / 100,
      diskWarn: v.diskWarn / 100,
      diskCrit: v.diskCrit / 100,
      netWarn: v.netWarn,
      netCrit: v.netCrit,
      errorsWarn: v.errorsWarn / 100,
      errorsCrit: v.errorsCrit / 100,
      p95Warn: v.p95Warn / 1000,
      p95Crit: v.p95Crit / 1000,
    };
  }
}
