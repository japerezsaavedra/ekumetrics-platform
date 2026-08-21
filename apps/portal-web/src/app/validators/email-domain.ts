import { AbstractControl, ValidationErrors, ValidatorFn, Validators } from '@angular/forms';

export const CORPORATE_DOMAIN_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

export const corporateDomainValidators = [
  Validators.required,
  Validators.pattern(CORPORATE_DOMAIN_PATTERN),
];

export function emailMatchesDomain(getDomain: () => string): ValidatorFn {
  return (control: AbstractControl): ValidationErrors | null => {
    const email = String(control.value ?? '')
      .trim()
      .toLowerCase();
    const domain = String(getDomain() ?? '')
      .trim()
      .toLowerCase()
      .replace(/^@/, '');
    if (!email || !domain) {
      return null;
    }
    return email.endsWith(`@${domain}`) ? null : { emailDomain: true };
  };
}

export function emailMatchesSiblingDomain(domainKey: string, emailKey: string): ValidatorFn {
  return (group: AbstractControl): ValidationErrors | null => {
    const domain = String(group.get(domainKey)?.value ?? '')
      .trim()
      .toLowerCase()
      .replace(/^@/, '');
    const email = String(group.get(emailKey)?.value ?? '')
      .trim()
      .toLowerCase();
    if (!domain || !email) {
      return null;
    }
    return email.endsWith(`@${domain}`) ? null : { emailDomain: true };
  };
}
