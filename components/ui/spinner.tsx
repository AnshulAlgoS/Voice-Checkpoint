import { cn } from '@/lib/utils';
import { Loader2Icon } from 'lucide-react';

function Spinner({ className, ...props }: React.ComponentProps<'output'>) {
  return (
    <output
      data-slot="spinner"
      aria-label="Loading"
      className={cn('inline-flex items-center justify-center', className)}
      {...props}
    >
      <Loader2Icon aria-hidden className={cn('size-4 animate-spin', className)} />
    </output>
  );
}

export { Spinner };
