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
