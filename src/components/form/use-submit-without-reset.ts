"use client";

import { useTransition, type FormEvent } from "react";

/**
 * React 19 resets an uncontrolled <form action={...}> as soon as its action is
 * dispatched, so a server-side validation error ("Use at most 2 decimal
 * places") would also wipe the note, date and category the user had already
 * filled in. Dispatching the same action by hand from onSubmit keeps React
 * from resetting the form: the fields keep their values and the inline error
 * can be corrected in place. Native `required` validation still runs first.
 */
export function useSubmitWithoutReset(formAction: (payload: FormData) => void) {
  const [, startTransition] = useTransition();
  return (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    startTransition(() => formAction(formData));
  };
}
