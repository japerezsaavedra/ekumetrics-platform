import { AbstractControl, ValidationErrors, ValidatorFn } from '@angular/forms';

export function passwordMatch(passwordKey: string, confirmKey: string): ValidatorFn {
  return (group: AbstractControl): ValidationErrors | null => {
    const password = String(group.get(passwordKey)?.value ?? '');
    const confirm = String(group.get(confirmKey)?.value ?? '');
    if (!password || !confirm) {
      return null;
    }
    return password === confirm ? null : { passwordMatch: true };
  };
}

export function differentFrom(otherKey: string): ValidatorFn {
  return (control: AbstractControl): ValidationErrors | null => {
    const value = String(control.value ?? '');
    const other = String(control.parent?.get(otherKey)?.value ?? '');
    if (!value || !other) {
      return null;
    }
    return value === other ? { samePassword: true } : null;
  };
}
