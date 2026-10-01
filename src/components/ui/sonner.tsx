"use client"

import { useEffect, useState } from "react"
import { useTheme } from "next-themes"
import { Toaster as Sonner, type ToasterProps } from "sonner"
import { CircleCheckIcon, InfoIcon, TriangleAlertIcon, OctagonXIcon, Loader2Icon } from "lucide-react"

/**
 * Whether a phone-width screen has a dialog open. Below sm every dialog is a
 * bottom sheet (ui/dialog.tsx), and the bottom edge is also where a toast
 * lands (above the tab bar), so a toast raised by the action that opened the
 * dialog - "Transaction added" over the "It's that payment" question - sat on
 * the sheet's text. Watching the DOM rather than threading a flag keeps every
 * dialog, and every toast, covered without a call site changing. From sm up a
 * dialog is centred and the toast stays bottom-right, clear of it.
 */
function usePhoneDialogOpen(): boolean {
  const [open, setOpen] = useState(false)
  useEffect(() => {
    const phone = window.matchMedia("(max-width: 639.98px)")
    let frame = 0
    const update = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() =>
        setOpen(phone.matches && document.querySelector('[data-slot="dialog-content"][data-state="open"]') !== null)
      )
    }
    update()
    const observer = new MutationObserver(update)
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-state"] })
    phone.addEventListener("change", update)
    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
      phone.removeEventListener("change", update)
    }
  }, [])
  return open
}

const Toaster = ({ ...props }: ToasterProps) => {
  const { theme = "system" } = useTheme()
  const dialogOpen = usePhoneDialogOpen()

  return (
    <Sonner
      theme={theme as ToasterProps["theme"]}
      className="toaster group"
      icons={{
        success: (
          <CircleCheckIcon className="size-4" />
        ),
        info: (
          <InfoIcon className="size-4" />
        ),
        warning: (
          <TriangleAlertIcon className="size-4" />
        ),
        error: (
          <OctagonXIcon className="size-4" />
        ),
        loading: (
          <Loader2Icon className="size-4 animate-spin" />
        ),
      }}
      style={
        {
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--border)",
          "--border-radius": "var(--radius)",
        } as React.CSSProperties
      }
      toastOptions={{
        classNames: {
          toast: "cn-toast",
        },
      }}
      {...props}
      {...(dialogOpen ? { position: "top-center" as const } : {})}
    />
  )
}

export { Toaster }
