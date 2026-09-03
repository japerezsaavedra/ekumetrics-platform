import { SetMetadata } from '@nestjs/common';

export const ALLOW_KIOSK = 'allowKiosk';
export const AllowKiosk = () => SetMetadata(ALLOW_KIOSK, true);
