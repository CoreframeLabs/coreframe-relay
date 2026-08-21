/**
 * LOCAL EDIT to a generated shadcn component — preserve when regenerating.
 *
 * react-i18next augments React's global `HTMLAttributes<T>` so `children` becomes
 * `ReactI18NextChildren | Iterable<ReactI18NextChildren>`, which includes
 * `Record<string, unknown>`. Radix primitives type their children as plain `ReactNode`,
 * so passing the destructured `children` straight through fails to typecheck.
 *
 * Narrowed at the render site rather than by disabling the augmentation globally:
 * `allowObjectInHTMLChildren: false` on i18next's CustomTypeOptions was tried and has no
 * effect in i18next 25 (it no longer exports `TypeOptions`), and BoxyHQ's existing pages
 * depend on react-i18next's `<Trans>` typings. See components/ui/button.tsx.
 */
import * as React from "react"
import * as DialogPrimitive from "@radix-ui/react-dialog"
import { X } from "lucide-react"

import { cn } from "@/lib/utils"

const Dialog = DialogPrimitive.Root

const DialogTrigger = DialogPrimitive.Trigger

const DialogPortal = DialogPrimitive.Portal

const DialogClose = DialogPrimitive.Close

const DialogOverlay = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Overlay
    ref={ref}
    className={cn(
      "fixed inset-0 z-50 bg-black/80  data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
      className
    )}
    {...props}
  />
))
DialogOverlay.displayName = DialogPrimitive.Overlay.displayName

const DialogContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content>
>(({ className, children, ...props }, ref) => (
  <DialogPortal>
    <DialogOverlay />
    <DialogPrimitive.Content
      ref={ref}
      // [RELAY-107] Glass per ui-revamp-spec-2026-08-19.md §4.2 — "modals/dialogs" is a
      // named glass target, and this is the shared shadcn `DialogContent` primitive under
      // every dialog in the app (`NewRouteWizard.tsx`'s real light/dark-toggle-aware
      // modal, and the base `DlqRetryButton.tsx` overrides below). Editing it once here —
      // rather than patching each call site — matches the spec's own guidance on `Card`
      // in `LandingPrimitives.tsx`: retune the shared surface, don't re-invent per usage.
      // `border`/`bg-background` (a bare-HSL token with no alpha slot) replaced with the
      // spec's literal glass values so the `/NN` opacity actually applies.
      className={cn(
        "fixed left-[50%] top-[50%] z-50 grid w-full max-w-lg translate-x-[-50%] translate-y-[-50%] gap-4 border border-white/60 bg-white/70 p-6 shadow-lg backdrop-blur-md backdrop-saturate-150 duration-200 dark:border-white/10 dark:bg-[#191b20]/60 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[state=closed]:slide-out-to-left-1/2 data-[state=closed]:slide-out-to-top-[48%] data-[state=open]:slide-in-from-left-1/2 data-[state=open]:slide-in-from-top-[48%] sm:rounded-lg",
        className
      )}
      {...props}
    >
      {children as React.ReactNode}
      <DialogPrimitive.Close className="absolute right-4 top-4 rounded-sm opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:pointer-events-none data-[state=open]:bg-accent data-[state=open]:text-muted-foreground">
        <X className="h-4 w-4" />
        {/* eslint-disable-next-line i18next/no-literal-string --
        Generated shadcn primitive. Adding a `useTranslation` call here would put an
        app-level i18n dependency inside a UI primitive AND become one more hand edit
        that regenerating this component silently destroys — the recurring tax
        RELAY-19 exists to remove. Translated copy belongs in the components that use
        this dialog, which is where BoxyHQ puts it. */}
        <span className="sr-only">Close</span>
      </DialogPrimitive.Close>
    </DialogPrimitive.Content>
  </DialogPortal>
))
DialogContent.displayName = DialogPrimitive.Content.displayName

const DialogHeader = ({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn(
      "flex flex-col space-y-1.5 text-center sm:text-left",
      className
    )}
    {...props}
  />
)
DialogHeader.displayName = "DialogHeader"

const DialogFooter = ({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn(
      "flex flex-col-reverse sm:flex-row sm:justify-end sm:space-x-2",
      className
    )}
    {...props}
  />
)
DialogFooter.displayName = "DialogFooter"

const DialogTitle = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title
    ref={ref}
    className={cn(
      "text-lg font-semibold leading-none tracking-tight",
      className
    )}
    {...props}
  />
))
DialogTitle.displayName = DialogPrimitive.Title.displayName

const DialogDescription = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description
    ref={ref}
    className={cn("text-sm text-muted-foreground", className)}
    {...props}
  />
))
DialogDescription.displayName = DialogPrimitive.Description.displayName

export {
  Dialog,
  DialogPortal,
  DialogOverlay,
  DialogTrigger,
  DialogClose,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
}
