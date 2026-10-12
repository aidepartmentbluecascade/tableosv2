-- No per-base record cap on any plan.
UPDATE core.plans SET limits = limits - 'recordsPerBase' WHERE limits ? 'recordsPerBase';
