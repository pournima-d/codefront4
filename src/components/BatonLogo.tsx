import React from 'react';

interface BatonLogoProps {
  variant?: 'hero' | 'full' | 'compact';
  className?: string;
}

export function BatonLogo({ variant = 'full', className = '' }: BatonLogoProps) {
  const emblemSize =
    variant === 'hero'
      ? 'h-16 w-16 sm:h-20 sm:w-20'
      : variant === 'full'
        ? 'h-12 w-12 sm:h-14 sm:w-14'
        : 'h-10 w-10';
  const wordmarkHeight =
    variant === 'hero'
      ? 'h-12 sm:h-14'
      : variant === 'full'
        ? 'h-10 sm:h-11'
        : 'h-8';

  return (
    <div className={`inline-flex items-center gap-3 select-none shrink-0 ${className}`}>
      <img
        src="/src/assets/images/baton_knot_emblem_1794838777387.jpg"
        alt="BATON knot emblem"
        referrerPolicy="no-referrer"
        className={`${emblemSize} object-contain mix-blend-multiply shrink-0`}
      />
      <img
        src="/src/assets/images/baton_wordmark_logo_1794838777795.jpg"
        alt="BATON"
        referrerPolicy="no-referrer"
        className={`${wordmarkHeight} w-auto object-contain mix-blend-multiply shrink-0`}
      />
    </div>
  );
}
