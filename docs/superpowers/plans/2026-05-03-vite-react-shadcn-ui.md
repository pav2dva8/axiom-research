# Vite + React + shadcn UI Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the single static `index.html` viewer UI with a Vite + React + Tailwind + shadcn app, served by the existing Node server.

**Architecture:** The React app lives in `src/ui/web/`. Vite builds it to `src/ui/web/dist/`. The existing `server.ts` is updated to serve from that dist folder instead of `src/ui/public/`. During development, a Vite dev server (port 5173) proxies `/api` and WebSocket traffic to the Node backend (port 3847).

**Tech Stack:** Vite 5, React 18, TypeScript, Tailwind CSS v3, shadcn/ui (Radix primitives + CVA), lucide-react, ws (existing backend unchanged)

---

## File Map

### New files (created)
| Path | Responsibility |
|---|---|
| `src/ui/web/index.html` | Vite entry HTML |
| `src/ui/web/vite.config.ts` | Vite config (proxy, outDir) |
| `src/ui/web/tsconfig.json` | TS config for React app |
| `src/ui/web/tailwind.config.js` | Tailwind with shadcn CSS vars |
| `src/ui/web/postcss.config.js` | PostCSS for Tailwind |
| `src/ui/web/src/index.css` | Tailwind directives + shadcn CSS vars |
| `src/ui/web/src/main.tsx` | React root mount |
| `src/ui/web/src/App.tsx` | Root component — WS state, layout |
| `src/ui/web/src/lib/utils.ts` | `cn()` helper |
| `src/ui/web/src/components/ui/button.tsx` | shadcn Button |
| `src/ui/web/src/components/ui/card.tsx` | shadcn Card |
| `src/ui/web/src/components/ui/input.tsx` | shadcn Input |
| `src/ui/web/src/components/ui/badge.tsx` | shadcn Badge |
| `src/ui/web/src/components/ui/scroll-area.tsx` | shadcn ScrollArea |
| `src/ui/web/src/components/ui/separator.tsx` | shadcn Separator |
| `src/ui/web/src/components/StatusBar.tsx` | Accounts + Active counters |
| `src/ui/web/src/components/AccountsPanel.tsx` | Re-login All / Stop |
| `src/ui/web/src/components/ViewersPanel.tsx` | Pair input, token info, Start/Stop |
| `src/ui/web/src/components/LogPanel.tsx` | Scrollable event log |

### Modified files
| Path | Change |
|---|---|
| `package.json` | Add frontend deps + `build:web`, `dev:web` scripts |
| `src/ui/server.ts` | Serve `src/ui/web/dist/` instead of `src/ui/public/` |

---

## Task 1: Install frontend dependencies

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install Vite, React, TypeScript types**

```bash
cd /Users/pavlo/Projects/axiom-research
npm install --save-dev vite @vitejs/plugin-react
npm install react react-dom
npm install --save-dev @types/react @types/react-dom
```

- [ ] **Step 2: Install Tailwind + PostCSS**

```bash
npm install --save-dev tailwindcss@^3 postcss autoprefixer
```

- [ ] **Step 3: Install shadcn primitives and utilities**

```bash
npm install @radix-ui/react-slot @radix-ui/react-scroll-area @radix-ui/react-separator
npm install class-variance-authority clsx tailwind-merge
npm install lucide-react
```

- [ ] **Step 4: Verify package.json has all new deps listed**

```bash
node -e "const p=require('./package.json'); ['vite','react','react-dom','tailwindcss','class-variance-authority','clsx','tailwind-merge','lucide-react'].forEach(d=>{ if(!p.dependencies[d]&&!p.devDependencies[d]) console.error('MISSING:',d); else console.log('OK:',d); })"
```

Expected: all lines print `OK:`

---

## Task 2: Vite project scaffolding

**Files:**
- Create: `src/ui/web/index.html`
- Create: `src/ui/web/vite.config.ts`
- Create: `src/ui/web/tsconfig.json`
- Create: `src/ui/web/postcss.config.js`
- Create: `src/ui/web/tailwind.config.js`

- [ ] **Step 1: Create directory**

```bash
mkdir -p src/ui/web/src/components/ui src/ui/web/src/lib
```

- [ ] **Step 2: Create `src/ui/web/index.html`**

```html
<!DOCTYPE html>
<html lang="en" class="dark">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Axiom Viewer Bot</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 3: Create `src/ui/web/vite.config.ts`**

```ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  root: __dirname,
  plugins: [react()],
  resolve: {
    alias: { '@': path.resolve(__dirname, './src') },
  },
  build: {
    outDir: path.resolve(__dirname, 'dist'),
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://localhost:3847', changeOrigin: true },
      '/ws': {
        target: 'ws://localhost:3847',
        ws: true,
      },
    },
  },
});
```

- [ ] **Step 4: Create `src/ui/web/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "useDefineForClassFields": true,
    "lib": ["ES2020", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "skipLibCheck": true,
    "moduleResolution": "bundler",
    "allowImportingTsExtensions": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noEmit": true,
    "jsx": "react-jsx",
    "strict": true,
    "baseUrl": ".",
    "paths": { "@/*": ["./src/*"] }
  },
  "include": ["src"]
}
```

- [ ] **Step 5: Create `src/ui/web/postcss.config.js`**

```js
export default {
  plugins: {
    tailwindcss: {},
    autoprefixer: {},
  },
};
```

- [ ] **Step 6: Create `src/ui/web/tailwind.config.js`**

```js
/** @type {import('tailwindcss').Config} */
export default {
  darkMode: ['class'],
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        border: 'hsl(var(--border))',
        input: 'hsl(var(--input))',
        ring: 'hsl(var(--ring))',
        background: 'hsl(var(--background))',
        foreground: 'hsl(var(--foreground))',
        primary: {
          DEFAULT: 'hsl(var(--primary))',
          foreground: 'hsl(var(--primary-foreground))',
        },
        secondary: {
          DEFAULT: 'hsl(var(--secondary))',
          foreground: 'hsl(var(--secondary-foreground))',
        },
        destructive: {
          DEFAULT: 'hsl(var(--destructive))',
          foreground: 'hsl(var(--destructive-foreground))',
        },
        muted: {
          DEFAULT: 'hsl(var(--muted))',
          foreground: 'hsl(var(--muted-foreground))',
        },
        accent: {
          DEFAULT: 'hsl(var(--accent))',
          foreground: 'hsl(var(--accent-foreground))',
        },
        card: {
          DEFAULT: 'hsl(var(--card))',
          foreground: 'hsl(var(--card-foreground))',
        },
      },
      borderRadius: {
        lg: 'var(--radius)',
        md: 'calc(var(--radius) - 2px)',
        sm: 'calc(var(--radius) - 4px)',
      },
    },
  },
  plugins: [],
};
```

---

## Task 3: CSS variables + global styles

**Files:**
- Create: `src/ui/web/src/index.css`

- [ ] **Step 1: Create `src/ui/web/src/index.css`**

```css
@tailwind base;
@tailwind components;
@tailwind utilities;

@layer base {
  :root {
    --background: 0 0% 3%;
    --foreground: 0 0% 88%;
    --card: 240 10% 10%;
    --card-foreground: 0 0% 88%;
    --border: 240 6% 18%;
    --input: 240 6% 10%;
    --ring: 197 100% 50%;
    --primary: 197 100% 50%;
    --primary-foreground: 0 0% 0%;
    --secondary: 240 6% 22%;
    --secondary-foreground: 0 0% 88%;
    --muted: 240 6% 14%;
    --muted-foreground: 0 0% 53%;
    --accent: 240 6% 18%;
    --accent-foreground: 0 0% 88%;
    --destructive: 348 83% 60%;
    --destructive-foreground: 0 0% 100%;
    --radius: 0.5rem;
  }
}

@layer base {
  * { @apply border-border; }
  body { @apply bg-background text-foreground; }
}
```

---

## Task 4: lib/utils + shadcn UI primitives

**Files:**
- Create: `src/ui/web/src/lib/utils.ts`
- Create: `src/ui/web/src/components/ui/button.tsx`
- Create: `src/ui/web/src/components/ui/card.tsx`
- Create: `src/ui/web/src/components/ui/input.tsx`
- Create: `src/ui/web/src/components/ui/badge.tsx`
- Create: `src/ui/web/src/components/ui/scroll-area.tsx`
- Create: `src/ui/web/src/components/ui/separator.tsx`

- [ ] **Step 1: Create `src/ui/web/src/lib/utils.ts`**

```ts
import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
```

- [ ] **Step 2: Create `src/ui/web/src/components/ui/button.tsx`**

```tsx
import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

const buttonVariants = cva(
  'inline-flex items-center justify-center whitespace-nowrap rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50',
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground shadow hover:bg-primary/90',
        destructive: 'bg-destructive text-destructive-foreground shadow-sm hover:bg-destructive/90',
        outline: 'border border-input bg-transparent shadow-sm hover:bg-accent hover:text-accent-foreground',
        secondary: 'bg-secondary text-secondary-foreground shadow-sm hover:bg-secondary/80',
        ghost: 'hover:bg-accent hover:text-accent-foreground',
        link: 'text-primary underline-offset-4 hover:underline',
      },
      size: {
        default: 'h-9 px-4 py-2',
        sm: 'h-8 rounded-md px-3 text-xs',
        lg: 'h-10 rounded-md px-8',
        icon: 'h-9 w-9',
      },
    },
    defaultVariants: { variant: 'default', size: 'default' },
  }
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : 'button';
    return <Comp className={cn(buttonVariants({ variant, size, className }))} ref={ref} {...props} />;
  }
);
Button.displayName = 'Button';

export { Button, buttonVariants };
```

- [ ] **Step 3: Create `src/ui/web/src/components/ui/card.tsx`**

```tsx
import * as React from 'react';
import { cn } from '@/lib/utils';

const Card = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cn('rounded-xl border bg-card text-card-foreground shadow', className)} {...props} />
  )
);
Card.displayName = 'Card';

const CardHeader = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cn('flex flex-col space-y-1.5 p-4', className)} {...props} />
  )
);
CardHeader.displayName = 'CardHeader';

const CardTitle = React.forwardRef<HTMLParagraphElement, React.HTMLAttributes<HTMLHeadingElement>>(
  ({ className, ...props }, ref) => (
    <h3 ref={ref} className={cn('text-sm font-semibold leading-none tracking-tight', className)} {...props} />
  )
);
CardTitle.displayName = 'CardTitle';

const CardContent = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cn('p-4 pt-0', className)} {...props} />
  )
);
CardContent.displayName = 'CardContent';

export { Card, CardHeader, CardTitle, CardContent };
```

- [ ] **Step 4: Create `src/ui/web/src/components/ui/input.tsx`**

```tsx
import * as React from 'react';
import { cn } from '@/lib/utils';

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {}

const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, type, ...props }, ref) => (
    <input
      type={type}
      className={cn(
        'flex h-9 w-full rounded-md border border-input bg-input px-3 py-1 text-sm shadow-sm transition-colors file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50',
        className
      )}
      ref={ref}
      {...props}
    />
  )
);
Input.displayName = 'Input';

export { Input };
```

- [ ] **Step 5: Create `src/ui/web/src/components/ui/badge.tsx`**

```tsx
import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

const badgeVariants = cva(
  'inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-semibold transition-colors',
  {
    variants: {
      variant: {
        default: 'border-transparent bg-primary text-primary-foreground',
        secondary: 'border-transparent bg-secondary text-secondary-foreground',
        destructive: 'border-transparent bg-destructive text-destructive-foreground',
        outline: 'text-foreground',
        success: 'border-transparent bg-emerald-500/20 text-emerald-400',
      },
    },
    defaultVariants: { variant: 'default' },
  }
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return <div className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { Badge, badgeVariants };
```

- [ ] **Step 6: Create `src/ui/web/src/components/ui/scroll-area.tsx`**

```tsx
import * as React from 'react';
import * as ScrollAreaPrimitive from '@radix-ui/react-scroll-area';
import { cn } from '@/lib/utils';

const ScrollArea = React.forwardRef<
  React.ElementRef<typeof ScrollAreaPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof ScrollAreaPrimitive.Root>
>(({ className, children, ...props }, ref) => (
  <ScrollAreaPrimitive.Root ref={ref} className={cn('relative overflow-hidden', className)} {...props}>
    <ScrollAreaPrimitive.Viewport className="h-full w-full rounded-[inherit]">
      {children}
    </ScrollAreaPrimitive.Viewport>
    <ScrollBar />
    <ScrollAreaPrimitive.Corner />
  </ScrollAreaPrimitive.Root>
));
ScrollArea.displayName = ScrollAreaPrimitive.Root.displayName;

const ScrollBar = React.forwardRef<
  React.ElementRef<typeof ScrollAreaPrimitive.ScrollAreaScrollbar>,
  React.ComponentPropsWithoutRef<typeof ScrollAreaPrimitive.ScrollAreaScrollbar>
>(({ className, orientation = 'vertical', ...props }, ref) => (
  <ScrollAreaPrimitive.ScrollAreaScrollbar
    ref={ref}
    orientation={orientation}
    className={cn(
      'flex touch-none select-none transition-colors',
      orientation === 'vertical' && 'h-full w-2.5 border-l border-l-transparent p-[1px]',
      orientation === 'horizontal' && 'h-2.5 flex-col border-t border-t-transparent p-[1px]',
      className
    )}
    {...props}
  >
    <ScrollAreaPrimitive.ScrollAreaThumb className="relative flex-1 rounded-full bg-border" />
  </ScrollAreaPrimitive.ScrollAreaScrollbar>
));
ScrollBar.displayName = ScrollAreaPrimitive.ScrollAreaScrollbar.displayName;

export { ScrollArea, ScrollBar };
```

- [ ] **Step 7: Create `src/ui/web/src/components/ui/separator.tsx`**

```tsx
import * as React from 'react';
import * as SeparatorPrimitive from '@radix-ui/react-separator';
import { cn } from '@/lib/utils';

const Separator = React.forwardRef<
  React.ElementRef<typeof SeparatorPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof SeparatorPrimitive.Root>
>(({ className, orientation = 'horizontal', decorative = true, ...props }, ref) => (
  <SeparatorPrimitive.Root
    ref={ref}
    decorative={decorative}
    orientation={orientation}
    className={cn(
      'shrink-0 bg-border',
      orientation === 'horizontal' ? 'h-[1px] w-full' : 'h-full w-[1px]',
      className
    )}
    {...props}
  />
));
Separator.displayName = SeparatorPrimitive.Root.displayName;

export { Separator };
```

---

## Task 5: Feature components

**Files:**
- Create: `src/ui/web/src/components/StatusBar.tsx`
- Create: `src/ui/web/src/components/AccountsPanel.tsx`
- Create: `src/ui/web/src/components/ViewersPanel.tsx`
- Create: `src/ui/web/src/components/LogPanel.tsx`

- [ ] **Step 1: Create `src/ui/web/src/components/StatusBar.tsx`**

```tsx
import { Users, Eye } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';

interface Props {
  accounts: number;
  activeViewers: number;
}

export function StatusBar({ accounts, activeViewers }: Props) {
  return (
    <div className="grid grid-cols-2 gap-3">
      <Card>
        <CardContent className="flex items-center gap-3 p-4">
          <Users className="h-4 w-4 text-muted-foreground" />
          <div>
            <p className="text-2xl font-bold text-primary">{accounts}</p>
            <p className="text-xs uppercase text-muted-foreground tracking-wider">Accounts</p>
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardContent className="flex items-center gap-3 p-4">
          <Eye className="h-4 w-4 text-muted-foreground" />
          <div>
            <p className="text-2xl font-bold text-emerald-400">{activeViewers}</p>
            <p className="text-xs uppercase text-muted-foreground tracking-wider">Active</p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
```

- [ ] **Step 2: Create `src/ui/web/src/components/AccountsPanel.tsx`**

```tsx
import { useState } from 'react';
import { RefreshCw, Square } from 'lucide-react';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';

interface Props {
  onLog: (msg: string, type: 'success' | 'error' | 'info') => void;
}

export function AccountsPanel({ onLog }: Props) {
  const [relogging, setRelogging] = useState(false);

  async function reloginAll() {
    setRelogging(true);
    onLog('Re-logging in all accounts...', 'info');
    try {
      const res = await fetch('/api/accounts/relogin', { method: 'POST' });
      const data = await res.json();
      onLog(`Re-logged in ${data.success}/${data.total} accounts`, 'success');
    } catch (err: any) {
      onLog(`Error: ${err.message}`, 'error');
    }
    setRelogging(false);
  }

  async function stopRelogin() {
    await fetch('/api/accounts/relogin/stop', { method: 'POST' });
    onLog('Stopping re-login...', 'info');
    setRelogging(false);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Users className="h-3.5 w-3.5" /> Accounts
        </CardTitle>
      </CardHeader>
      <CardContent className="flex gap-2">
        {!relogging ? (
          <Button variant="secondary" size="sm" onClick={reloginAll}>
            <RefreshCw className="h-3.5 w-3.5 mr-1.5" /> Re-login All
          </Button>
        ) : (
          <Button variant="destructive" size="sm" onClick={stopRelogin}>
            <Square className="h-3.5 w-3.5 mr-1.5" /> Stop
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
```

Fix the missing `Users` import in AccountsPanel:

```tsx
import { useState } from 'react';
import { RefreshCw, Square, Users } from 'lucide-react';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';

interface Props {
  onLog: (msg: string, type: 'success' | 'error' | 'info') => void;
}

export function AccountsPanel({ onLog }: Props) {
  const [relogging, setRelogging] = useState(false);

  async function reloginAll() {
    setRelogging(true);
    onLog('Re-logging in all accounts...', 'info');
    try {
      const res = await fetch('/api/accounts/relogin', { method: 'POST' });
      const data = await res.json();
      onLog(`Re-logged in ${data.success}/${data.total} accounts`, 'success');
    } catch (err: any) {
      onLog(`Error: ${err.message}`, 'error');
    }
    setRelogging(false);
  }

  async function stopRelogin() {
    await fetch('/api/accounts/relogin/stop', { method: 'POST' });
    onLog('Stopping re-login...', 'info');
    setRelogging(false);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Users className="h-3.5 w-3.5" /> Accounts
        </CardTitle>
      </CardHeader>
      <CardContent className="flex gap-2">
        {!relogging ? (
          <Button variant="secondary" size="sm" onClick={reloginAll}>
            <RefreshCw className="h-3.5 w-3.5 mr-1.5" /> Re-login All
          </Button>
        ) : (
          <Button variant="destructive" size="sm" onClick={stopRelogin}>
            <Square className="h-3.5 w-3.5 mr-1.5" /> Stop
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
```

- [ ] **Step 3: Create `src/ui/web/src/components/ViewersPanel.tsx`**

```tsx
import { useState } from 'react';
import { Play, Square, Eye } from 'lucide-react';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';

interface TokenInfo {
  ticker: string;
  name: string;
}

interface Props {
  onLog: (msg: string, type: 'success' | 'error' | 'info') => void;
}

export function ViewersPanel({ onLog }: Props) {
  const [pairAddress, setPairAddress] = useState('');
  const [tokenInfo, setTokenInfo] = useState<TokenInfo | null>(null);
  const [starting, setStarting] = useState(false);

  async function fetchTokenInfo(addr: string) {
    if (!addr) return;
    try {
      const res = await fetch(`/api/token-info?pairAddress=${addr}`);
      const data = await res.json();
      if (data.ticker) setTokenInfo({ ticker: data.ticker, name: data.name });
    } catch {}
  }

  async function startViewers() {
    if (!pairAddress) { onLog('Please enter a pair address', 'error'); return; }
    setStarting(true);
    try {
      const res = await fetch('/api/viewers/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pairAddress }),
      });
      const data = await res.json();
      if (data.tokenInfo) setTokenInfo({ ticker: data.tokenInfo.ticker, name: data.tokenInfo.name });
      onLog(`Started ${data.connected} viewers on ${data.tokenInfo?.ticker ?? 'token'}`, 'success');
    } catch (err: any) {
      onLog(`Error: ${err.message}`, 'error');
    }
    setStarting(false);
  }

  async function stopViewers() {
    try {
      await fetch('/api/viewers/stop', { method: 'POST' });
      onLog('All viewers stopped', 'success');
    } catch (err: any) {
      onLog(`Error: ${err.message}`, 'error');
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Eye className="h-3.5 w-3.5" /> Viewers
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <Input
          placeholder="Pair address from Axiom URL"
          value={pairAddress}
          onChange={(e) => setPairAddress(e.target.value)}
          onBlur={() => fetchTokenInfo(pairAddress)}
        />
        {tokenInfo && (
          <div className="flex items-center gap-2">
            <Badge variant="outline" className="text-primary border-primary/40 font-mono">
              {tokenInfo.ticker}
            </Badge>
            <span className="text-xs text-muted-foreground">{tokenInfo.name}</span>
          </div>
        )}
        <div className="flex gap-2">
          <Button onClick={startViewers} disabled={starting} className="flex-1">
            <Play className="h-3.5 w-3.5 mr-1.5" /> Start
          </Button>
          <Button variant="destructive" onClick={stopViewers} className="flex-1">
            <Square className="h-3.5 w-3.5 mr-1.5" /> Stop
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
```

- [ ] **Step 4: Create `src/ui/web/src/components/LogPanel.tsx`**

```tsx
import { useEffect, useRef } from 'react';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';
import { Terminal } from 'lucide-react';

export interface LogEntry {
  id: number;
  time: string;
  message: string;
  type: 'success' | 'error' | 'info';
}

interface Props {
  entries: LogEntry[];
}

export function LogPanel({ entries }: Props) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [entries]);

  return (
    <Card className="flex flex-col flex-1 min-h-0">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2">
          <Terminal className="h-3.5 w-3.5" /> Log
        </CardTitle>
      </CardHeader>
      <CardContent className="flex-1 min-h-0 pt-0">
        <ScrollArea className="h-full rounded-md border border-border bg-input p-2">
          <div className="space-y-0.5 font-mono text-xs">
            {entries.map((e) => (
              <div key={e.id} className="flex gap-2 py-0.5 border-b border-border/40">
                <span className="text-muted-foreground shrink-0">{e.time}</span>
                <span className={cn(
                  e.type === 'success' && 'text-emerald-400',
                  e.type === 'error' && 'text-destructive',
                  e.type === 'info' && 'text-primary',
                )}>
                  {e.message}
                </span>
              </div>
            ))}
            <div ref={bottomRef} />
          </div>
        </ScrollArea>
      </CardContent>
    </Card>
  );
}
```

---

## Task 6: Root App + main entry

**Files:**
- Create: `src/ui/web/src/App.tsx`
- Create: `src/ui/web/src/main.tsx`

- [ ] **Step 1: Create `src/ui/web/src/App.tsx`**

```tsx
import { useEffect, useRef, useState, useCallback } from 'react';
import { StatusBar } from '@/components/StatusBar';
import { AccountsPanel } from '@/components/AccountsPanel';
import { ViewersPanel } from '@/components/ViewersPanel';
import { LogPanel, type LogEntry } from '@/components/LogPanel';

interface Status {
  accounts: number;
  activeViewers: number;
}

let logIdCounter = 0;

export default function App() {
  const [status, setStatus] = useState<Status>({ accounts: 0, activeViewers: 0 });
  const [logEntries, setLogEntries] = useState<LogEntry[]>([]);
  const wsRef = useRef<WebSocket | null>(null);

  const addLog = useCallback((message: string, type: LogEntry['type'] = 'info') => {
    const entry: LogEntry = {
      id: ++logIdCounter,
      time: new Date().toLocaleTimeString(),
      message,
      type,
    };
    setLogEntries((prev) => [...prev.slice(-99), entry]);
  }, []);

  useEffect(() => {
    function connect() {
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const ws = new WebSocket(`${protocol}//${window.location.host}`);
      wsRef.current = ws;

      ws.onopen = () => addLog('Connected to server', 'success');
      ws.onclose = () => {
        addLog('Disconnected — reconnecting...', 'error');
        setTimeout(connect, 3000);
      };
      ws.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        if (msg.type === 'status') {
          setStatus({ accounts: msg.data.accounts, activeViewers: msg.data.activeViewers });
        } else if (msg.type === 'relogin-progress') {
          addLog(`[${msg.data.done}/${msg.data.total}] ${msg.data.message}`, 'info');
        }
      };
    }
    connect();
    return () => wsRef.current?.close();
  }, [addLog]);

  return (
    <div className="flex flex-col h-screen max-w-2xl mx-auto p-3 gap-3">
      <StatusBar accounts={status.accounts} activeViewers={status.activeViewers} />
      <AccountsPanel onLog={addLog} />
      <ViewersPanel onLog={addLog} />
      <LogPanel entries={logEntries} />
    </div>
  );
}
```

- [ ] **Step 2: Create `src/ui/web/src/main.tsx`**

```tsx
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import App from './App';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
```

---

## Task 7: Wire up server + package.json scripts

**Files:**
- Modify: `src/ui/server.ts`
- Modify: `package.json`

- [ ] **Step 1: Update `serveStatic` in `src/ui/server.ts` to serve from `src/ui/web/dist/`**

Replace the current `serveStatic` function and path reference. Find these lines:

```ts
// Serve static files
function serveStatic(req: http.IncomingMessage, res: http.ServerResponse): void {
  let filePath = req.url || '/';
  if (filePath === '/') filePath = '/index.html';

  const fullPath = path.join(__dirname, 'public', filePath);
```

Replace with:

```ts
// Serve static files from Vite build output
function serveStatic(req: http.IncomingMessage, res: http.ServerResponse): void {
  let filePath = req.url || '/';
  // SPA fallback: unknown paths → index.html
  const hasExt = path.extname(filePath).length > 0;
  if (!hasExt) filePath = '/index.html';

  const WEB_DIST = path.join(process.cwd(), 'src/ui/web/dist');
  const fullPath = path.join(WEB_DIST, filePath);
```

- [ ] **Step 2: Add scripts to `package.json`**

Add to the `scripts` object:

```json
"build:web": "vite build --config src/ui/web/vite.config.ts",
"dev:web": "vite --config src/ui/web/vite.config.ts"
```

Final scripts section:
```json
"scripts": {
  "build": "tsc",
  "start": "node dist/index.js",
  "dev": "tsx src/index.ts",
  "login": "tsx src/login.ts",
  "signup": "tsx src/login.ts --signup",
  "viewers": "tsx src/viewers.ts",
  "viewer-bot": "tsx src/ui/cli.ts",
  "viewer-ui": "tsx src/ui/server.ts",
  "build:web": "vite build --config src/ui/web/vite.config.ts",
  "dev:web": "vite --config src/ui/web/vite.config.ts"
}
```

---

## Task 8: Build + verify

- [ ] **Step 1: Build the web app**

```bash
npm run build:web
```

Expected output: `dist/` folder created inside `src/ui/web/`, containing `index.html` and assets.

- [ ] **Step 2: Start the Node server**

```bash
npm run viewer-ui
```

Expected: `🚀 Viewer Bot UI running at http://localhost:3847`

- [ ] **Step 3: Open in browser and check**

Visit `http://localhost:3847`. Verify:
- Dark themed UI with two stat cards (Accounts, Active)
- Accounts panel with Re-login All button
- Viewers panel with pair input and Start/Stop
- Log panel showing "Connected to server"
- No console errors

- [ ] **Step 4: Commit**

```bash
git add src/ui/web src/ui/server.ts package.json package-lock.json
git commit -m "feat: replace static HTML with Vite + React + shadcn UI"
```

---

## Dev Workflow (reference)

```bash
# Terminal 1 — backend
npm run viewer-ui

# Terminal 2 — frontend (hot reload)
npm run dev:web
# Open http://localhost:5173
```

Vite's proxy forwards `/api/*` and WS to the Node server on 3847.
