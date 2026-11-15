// @vitest-environment happy-dom
import { useState } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import * as matchers from "@testing-library/jest-dom/matchers"

import {
  FileUpload,
  FileUploadClear,
  FileUploadDropzone,
  FileUploadItem,
  FileUploadItemDelete,
  FileUploadItemMetadata,
  FileUploadItemPreview,
  FileUploadList,
  FileUploadTrigger,
} from "./file-upload"

expect.extend(matchers)
afterEach(() => cleanup())

function makeFile(name: string, content = "hello", type = "text/plain") {
  return new File([content], name, { type })
}

function DemoFileUpload(props: {
  onValueChange?: (files: File[]) => void
  onFileReject?: (file: File, message: string) => void
  maxFiles?: number
}) {
  return (
    <FileUpload {...props}>
      <FileUploadDropzone data-testid="dropzone">
        <FileUploadTrigger data-testid="trigger">Browse files</FileUploadTrigger>
      </FileUploadDropzone>
      <FileUploadList />
    </FileUpload>
  )
}

function DemoFileUploadWithList() {
  const [files, setFiles] = useState<File[]>([])
  return (
    <FileUpload value={files} onValueChange={setFiles}>
      <FileUploadDropzone data-testid="dropzone">
        <FileUploadTrigger data-testid="trigger">Browse files</FileUploadTrigger>
      </FileUploadDropzone>
      <FileUploadList>
        {files.map((file) => (
          <FileUploadItem key={file.name} value={file} data-testid="item">
            <FileUploadItemPreview />
            <FileUploadItemMetadata />
            <FileUploadItemDelete data-testid="delete">Remove</FileUploadItemDelete>
          </FileUploadItem>
        ))}
      </FileUploadList>
      <FileUploadClear data-testid="clear">Clear all</FileUploadClear>
    </FileUpload>
  )
}

describe("FileUpload (UI-11, upstream:libs/react-shared/ui/file-upload.tsx)", () => {
  it("renders a dropzone, trigger, and a hidden file input (smoke)", () => {
    render(<DemoFileUpload />)
    expect(screen.getByTestId("dropzone")).toHaveAttribute("role", "region")
    expect(screen.getByTestId("trigger")).toHaveTextContent("Browse files")
    expect(document.querySelector('input[type="file"]')).toBeInTheDocument()
  })

  it("clicking the trigger opens the native file picker (input is targeted)", async () => {
    const user = userEvent.setup()
    render(<DemoFileUpload />)
    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    const clickSpy = vi.spyOn(input, "click")

    await user.click(screen.getByTestId("trigger"))
    expect(clickSpy).toHaveBeenCalled()
  })

  it("accepts a file via the input and calls onValueChange with it", async () => {
    const user = userEvent.setup()
    const onValueChange = vi.fn()
    render(<DemoFileUpload onValueChange={onValueChange} />)

    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    const file = makeFile("notes.txt")

    await user.upload(input, file)

    expect(onValueChange).toHaveBeenCalledWith([file])
  })

  it("controlled mode fires onValueChange exactly once per add (DEBT-12)", async () => {
    const user = userEvent.setup()
    const onValueChange = vi.fn()
    function Controlled() {
      const [files, setFiles] = useState<File[]>([])
      return (
        <FileUpload
          value={files}
          onValueChange={(next) => {
            onValueChange(next)
            setFiles(next)
          }}
        >
          <FileUploadDropzone>
            <FileUploadTrigger>Browse</FileUploadTrigger>
          </FileUploadDropzone>
        </FileUpload>
      )
    }
    render(<Controlled />)
    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    const file = makeFile("once.txt")
    await user.upload(input, file)
    expect(onValueChange).toHaveBeenCalledTimes(1)
    expect(onValueChange).toHaveBeenCalledWith([file])
  })

  it("renders an accepted file as a FileUploadItem with name/size metadata, and clears it", async () => {
    const user = userEvent.setup()
    render(<DemoFileUploadWithList />)

    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    const file = makeFile("report.pdf", "x".repeat(2048), "application/pdf")

    await user.upload(input, file)

    expect(await screen.findByText("report.pdf")).toBeInTheDocument()
    expect(screen.getByText("2.0 KB")).toBeInTheDocument()

    await user.click(screen.getByTestId("clear"))
    expect(screen.queryByText("report.pdf")).toBeNull()
  })

  it("removes a single file via FileUploadItemDelete", async () => {
    const user = userEvent.setup()
    render(<DemoFileUploadWithList />)

    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    await user.upload(input, makeFile("a.txt"))
    expect(await screen.findByText("a.txt")).toBeInTheDocument()

    await user.click(screen.getByTestId("delete"))
    expect(screen.queryByText("a.txt")).toBeNull()
  })

  it("rejects files beyond maxFiles and reports a rejection message", async () => {
    const user = userEvent.setup()
    const onFileReject = vi.fn()
    render(<DemoFileUpload maxFiles={1} onFileReject={onFileReject} />)

    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    const first = makeFile("first.txt")
    const second = makeFile("second.txt")

    await user.upload(input, first)
    await user.upload(input, second)

    expect(onFileReject).toHaveBeenCalledWith(second, "Maximum 1 files allowed")
  })
})
