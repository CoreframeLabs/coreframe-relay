import { Button, Modal as DModal } from 'react-daisyui';
import { useTranslation } from 'next-i18next';

interface ModalProps {
  open: boolean;
  close: () => void;
  children: React.ReactNode;
}

interface BodyProps {
  children: React.ReactNode;
  className?: string;
}

const Modal = ({ open, close, children }: ModalProps) => {
  const { t } = useTranslation('common');

  return (
    // [RELAY-107] Glass per ui-revamp-spec-2026-08-19.md §4.2 — modals are named directly
    // as glass's strongest 2026 use case (the overlay context makes the blur meaningful:
    // it's showing you the page it's covering). `react-daisyui`'s `Modal` merges this
    // `className` onto its own `modal-box` element via `twMerge` (verified by reading
    // `react-daisyui@5.0.5/dist/react-daisyui.modern.js`), i.e. it targets the actual
    // panel surface, not the `<dialog>` wrapper — so this one change also covers
    // `ConfirmationDialog.tsx`, which composes this `Modal` rather than styling its own
    // surface. `.dark` sits on `<html>` app-wide, a real ancestor of the portalled dialog,
    // so `dark:` variants resolve correctly here.
    <DModal
      open={open}
      className="border border-white/60 bg-white/70 shadow-lg backdrop-blur-md backdrop-saturate-150 dark:border-white/10 dark:bg-[#191b20]/60"
    >
      <Button
        type="button"
        size="sm"
        shape="circle"
        className="btn absolute right-2 top-2 btn-ghost rounded-full"
        onClick={close}
        aria-label="close"
      >
        {t('x')}
      </Button>
      <div>{children}</div>
    </DModal>
  );
};

const Header = ({ children }: { children: React.ReactNode }) => {
  return <h3 className="font-bold text-lg">{children}</h3>;
};

const Description = ({ children }: { children: React.ReactNode }) => {
  return <p className="text-sm text-gray-700 pt-1">{children}</p>;
};

const Body = ({ children, className }: BodyProps) => {
  return <div className={`py-3 ${className}`}>{children}</div>;
};

const Footer = ({ children }: { children: React.ReactNode }) => {
  return <div className="flex justify-end gap-2">{children}</div>;
};

Modal.Header = Header;
Modal.Description = Description;
Modal.Body = Body;
Modal.Footer = Footer;

export default Modal;
