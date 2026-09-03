'use client';

import { useMemo } from 'react';
import katex from 'katex';

export function Latex({
  children,
  display = false,
  className,
}: {
  children: string;
  display?: boolean;
  className?: string;
}) {
  const html = useMemo(
    () => katex.renderToString(children, {
      displayMode: display,
      throwOnError: false,
      strict: false,
      output: 'htmlAndMathml',
    }),
    [children, display],
  );

  return (
    <span
      className={className}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
