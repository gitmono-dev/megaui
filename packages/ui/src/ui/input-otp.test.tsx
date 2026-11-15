// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import * as matchers from "@testing-library/jest-dom/matchers"

import { InputOTP, InputOTPGroup, InputOTPSeparator, InputOTPSlot } from "./input-otp"

expect.extend(matchers)
afterEach(async () => {
  cleanup()
  // `input-otp` schedules internal 0/10/50ms timeouts (input-otp's own
  // native-input/selection sync, not something this port controls) on
  // every value/focus change without clearing them on unmount. Draining
  // real time past 50ms here keeps them from firing after this test
  // file's happy-dom environment has been torn down.
  await new Promise((resolve) => setTimeout(resolve, 60))
})

function DemoOTP({ onComplete }: { onComplete?: (value: string) => void }) {
  return (
    <InputOTP maxLength={4} onComplete={onComplete}>
      <InputOTPGroup>
        <InputOTPSlot index={0} />
        <InputOTPSlot index={1} />
      </InputOTPGroup>
      <InputOTPSeparator data-testid="separator" />
      <InputOTPGroup>
        <InputOTPSlot index={2} />
        <InputOTPSlot index={3} />
      </InputOTPGroup>
    </InputOTP>
  )
}

describe("InputOTP (UI-11, upstream:libs/react-shared/ui/input-otp.tsx)", () => {
  it("renders a hidden text input plus one slot per character (smoke)", () => {
    render(<DemoOTP />)
    const input = screen.getByRole("textbox", { hidden: true })
    expect(input).toBeInTheDocument()
    expect(input).toHaveAttribute("data-slot", "input-otp")

    const separator = screen.getByTestId("separator")
    expect(separator).toHaveAttribute("role", "separator")
  })

  it("accepts typed digits and reflects them into the slots", async () => {
    const user = userEvent.setup()
    render(<DemoOTP />)
    const input = screen.getByRole("textbox", { hidden: true })

    await user.click(input)
    await user.keyboard("1234")

    expect(input).toHaveValue("1234")
  })

  it("calls onComplete once all slots are filled", async () => {
    const user = userEvent.setup()
    const onComplete = vi.fn()
    render(<DemoOTP onComplete={onComplete} />)
    const input = screen.getByRole("textbox", { hidden: true })

    await user.click(input)
    await user.keyboard("5678")

    expect(onComplete).toHaveBeenCalledWith("5678")
  })
})
