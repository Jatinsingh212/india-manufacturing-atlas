/**
 * SiblingsCard - the other 8-digit national lines in the same HS6 subheading (they share its trade
 * figures), with their owning ministry. Rows open the sibling's product page.
 */
import { useMemo } from 'react';
import { useNavigate } from 'react-router';
import { Rows3 } from 'lucide-react';
import type { ProductSibling } from '@/api/types';
import { Badge, Card, CodeLink, DataTable, type Column } from '@/components';
import { fmtCode } from '@/lib/format';
import { routes } from '@/lib/routes';
import { ProductLabel } from '@/pages/explore/shared';

export function SiblingsCard({ hs6, siblings, currentMinistry }: { hs6: string; siblings: ProductSibling[]; currentMinistry: string | null }) {
  const navigate = useNavigate();
  const columns = useMemo<Column<ProductSibling>[]>(
    () => [
      { key: 'hsn8', header: 'HS code', value: (r) => r.hsn8, render: (r) => <CodeLink code={r.hsn8} />, width: 120 },
      { key: 'description', header: 'Product', value: (r) => r.description, render: (r) => <ProductLabel row={{ description: r.description, full_description: null }} /> },
      {
        key: 'ministry',
        header: 'Ministry',
        value: (r) => r.ministry_short,
        render: (r) =>
          r.ministry_short ? (
            <Badge tone={r.ministry_short === currentMinistry ? 'neutral' : 'warning'} size="sm" title={r.ministry_short === currentMinistry ? 'Same owner' : 'Different owner from this line'}>
              {r.ministry_short}
            </Badge>
          ) : (
            <span className="text-muted">—</span>
          ),
        width: 120,
      },
    ],
    [currentMinistry],
  );
  return (
    <Card
      title={`Other lines in subheading ${fmtCode(hs6)}`}
      subtitle="National lines that share this subheading's trade figures; highlighted owners differ from this line"
      icon={Rows3}
    >
      <DataTable
        columns={columns}
        rows={siblings}
        rowKey={(r) => r.hsn8}
        dense
        maxHeight={360}
        onRowClick={(r) => navigate(routes.product(r.hsn8))}
        pagination={siblings.length > 10 ? { mode: 'client', pageSize: 10, pageSizeOptions: [10, 25, 50] } : false}
        emptyTitle="This is the only national line in its subheading"
        caption={`Other national lines in ${fmtCode(hs6)}`}
      />
    </Card>
  );
}
