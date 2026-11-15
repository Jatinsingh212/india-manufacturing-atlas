import { useState } from 'react';
import { BookOpen, Calendar, HelpCircle, Layers, Scale } from 'lucide-react';
import { Button } from './Button';
import { Modal } from './Overlay';

export interface ReconciliationModalProps {
  open?: boolean;
  isOpen?: boolean;
  onClose: () => void;
}

export function ReconciliationModal({ open, isOpen, onClose }: ReconciliationModalProps) {
  const isVisible = Boolean(open ?? isOpen);
  if (!isVisible) return null;

  return (
    <Modal open={isVisible} onClose={onClose} title="Why Trade Figures May Differ from OEC or UN Comtrade" size="lg">
      <div className="space-y-5 text-sm text-ink-2">
        <p className="text-[13.5px] leading-relaxed text-ink">
          When comparing trade statistics on the <b>India Manufacturing Atlas</b> against external portals like the{' '}
          <b>Observatory of Economic Complexity (OEC)</b>, <b>ITC Trade Map</b>, or <b>UN Comtrade</b>, differences of
          $5M to $50M+ appear for four standard economic and statistical reasons:
        </p>

        <div className="grid gap-3.5 sm:grid-cols-2">
          {/* Reason 1 */}
          <div className="rounded-xl border border-line bg-surface-2 p-3.5">
            <div className="flex items-center gap-2 font-semibold text-ink">
              <span className="flex size-6 items-center justify-center rounded-md bg-brand-soft text-brand-ink">
                <BookOpen className="size-3.5" />
              </span>
              1. HS Nomenclature Revision
            </div>
            <p className="mt-1.5 text-xs leading-relaxed text-muted">
              OEC screenshots frequently use <b>HS 2017 (HS17)</b>. The Atlas uses the latest <b>WCO HS 2022 (HS22)</b>.
              The 2022 WCO amendments introduced over 350 classification shifts across electronics, chemicals, auto parts,
              and textiles, changing subheading boundaries and multi-million-dollar totals.
            </p>
          </div>

          {/* Reason 2 */}
          <div className="rounded-xl border border-line bg-surface-2 p-3.5">
            <div className="flex items-center gap-2 font-semibold text-ink">
              <span className="flex size-6 items-center justify-center rounded-md bg-ok-soft text-ok-ink">
                <Calendar className="size-3.5" />
              </span>
              2. Fiscal Year vs. Calendar Year
            </div>
            <p className="mt-1.5 text-xs leading-relaxed text-muted">
              <b>DGFT / DGCIS TRADESTAT</b> reports by Indian Financial Year (<b>April 1 to March 31</b>).
              Global databases (OEC, UN Comtrade, World Bank) report by Calendar Year (<b>January 1 to December 31</b>).
              The 3-month seasonal shift routinely moves $10M–$50M+ between reporting cycles.
            </p>
          </div>

          {/* Reason 3 */}
          <div className="rounded-xl border border-line bg-surface-2 p-3.5">
            <div className="flex items-center gap-2 font-semibold text-ink">
              <span className="flex size-6 items-center justify-center rounded-md bg-brand-soft text-brand-ink">
                <Layers className="size-3.5" />
              </span>
              3. 8-Digit HSN vs. 6-Digit HS
            </div>
            <p className="mt-1.5 text-xs leading-relaxed text-muted">
              Global databases only publish data up to the <b>6-digit HS subheading level</b>. The Atlas integrates
              official <b>8-digit national tariff lines</b> directly from DGFT. Sibling 8-digit lines under the same 6-digit
              code have distinct national figures, whereas global sites only show the broad category aggregate.
            </p>
          </div>

          {/* Reason 4 */}
          <div className="rounded-xl border border-line bg-surface-2 p-3.5">
            <div className="flex items-center gap-2 font-semibold text-ink">
              <span className="flex size-6 items-center justify-center rounded-md bg-na-soft text-na-ink">
                <Scale className="size-3.5" />
              </span>
              4. Valuation: FOB vs. CIF
            </div>
            <p className="mt-1.5 text-xs leading-relaxed text-muted">
              Indian exports are recorded <b>FOB (Free on Board)</b> at the Indian port, while Indian imports are recorded{' '}
              <b>CIF (Cost, Insurance & Freight)</b>. In bilateral mirror trade, marine freight and transit insurance add an
              expected <b>8% to 12% margin</b> between origin and destination records.
            </p>
          </div>
        </div>

        <div className="rounded-lg bg-surface-3 p-3 text-xs leading-relaxed">
          <div className="font-semibold text-ink">Verified Examples from Official Reconciliation:</div>
          <ul className="mt-1 list-inside list-disc space-y-0.5 text-ink-2">
            <li><b>Toys (HS 9503)</b>: OEC HS17 = $238.49M vs. BACI HS22 = $229.22M vs. TRADESTAT FY24 = $169.45M</li>
            <li><b>Auto Parts (HS 8708)</b>: OEC HS17 = $7,971.22M vs. BACI HS22 = $8,061.41M vs. TRADESTAT FY24 = $7,508.86M</li>
            <li><b>EV Batteries (HS 850760)</b>: OEC HS17 = $118.78M vs. BACI HS22 = $123.47M vs. TRADESTAT FY24 = $76.43M</li>
          </ul>
        </div>

        <div className="flex justify-end pt-2">
          <Button variant="primary" size="sm" onClick={onClose}>
            Got it
          </Button>
        </div>
      </div>
    </Modal>
  );
}

/** Convenience button to trigger the Reconciliation modal from anywhere. */
export function ReconciliationHelpButton({
  size = 'xs',
  className,
  label = 'Why does my OEC/UN Comtrade screenshot differ by $10M?',
}: {
  size?: 'xs' | 'sm';
  className?: string;
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        variant="ghost"
        size={size}
        icon={HelpCircle}
        onClick={() => setOpen(true)}
        className={className}
        title="Understand why trade figures may differ from OEC or UN Comtrade"
      >
        {label}
      </Button>
      <ReconciliationModal isOpen={open} onClose={() => setOpen(false)} />
    </>
  );
}
