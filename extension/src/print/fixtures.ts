// Real CUPS output, captured on the dev Mac (macOS CUPS, mono laser, 2026-11-27)
// with the queue renamed to `Example_Printer`, the user to `user` and the job
// names to made-up ones. `LP_REQUEST_ID` and `LPSTAT_DEFAULT_NONE` are the
// documented shapes, not captures (no job was submitted, and the no-default case
// does not occur on this Mac).

export const LPSTAT_DEFAULT_DE = "System-Standardzielort: Example_Printer\n";
export const LPSTAT_DEFAULT_NONE = "no system default destination\n";
export const LP_REQUEST_ID = "request id is Example_Printer-27 (1 file(s))\n";

// Get-Printer-Attributes: idle, accepting, toner at 10 % (low limit 16).
export const PRINTER_IDLE = `"printer.test":
    Get-Printer-Attributes:
        attributes-charset (charset) = utf-8
        attributes-natural-language (naturalLanguage) = en
        printer-uri (uri) = ipp://localhost:631/printers/Example_Printer
        requested-attributes (1setOf keyword) = printer-name,printer-state,printer-state-reasons,printer-is-accepting-jobs,marker-names,marker-levels,marker-low-levels,marker-types,marker-colors
    Get printer attributes                                               [PASS]
        RECEIVED: 282 bytes in response
        status-code = successful-ok (successful-ok)
        attributes-charset (charset) = utf-8
        attributes-natural-language (naturalLanguage) = en
        printer-is-accepting-jobs (boolean) = true
        printer-state (enum) = idle
        printer-state-reasons (keyword) = toner-low-warning
        printer-name (nameWithoutLanguage) = Example_Printer
        marker-levels (integer) = 10
        marker-low-levels (integer) = 16
        marker-types (keyword) = toner
`;

// Same queue, stopped and not accepting, no toner warning (a synthetic variant
// of PRINTER_IDLE with the state words swapped).
export const PRINTER_STOPPED = PRINTER_IDLE.replace(
  "printer-state (enum) = idle",
  "printer-state (enum) = stopped",
)
  .replace(
    "printer-is-accepting-jobs (boolean) = true",
    "printer-is-accepting-jobs (boolean) = false",
  )
  .replace(
    "printer-state-reasons (keyword) = toner-low-warning",
    "printer-state-reasons (keyword) = paused",
  );

// Get-Printer-Attributes for a queue that does not exist.
export const PRINTER_NOT_FOUND = `"printer.test":
    Get-Printer-Attributes:
        attributes-charset (charset) = utf-8
        attributes-natural-language (naturalLanguage) = en
        printer-uri (uri) = ipp://localhost:631/printers/no-such-queue
    Get printer attributes                                               [FAIL]
        RECEIVED: 127 bytes in response
        status-code = client-error-not-found (The printer or class does not exist.)
        attributes-charset (charset) = utf-8
        attributes-natural-language (naturalLanguage) = en
        status-message (textWithoutLanguage) = The printer or class does not exist.
        EXPECTED: STATUS successful-ok (got client-error-not-found)
        status-message="The printer or class does not exist."
`;

// Get-Jobs (not-completed) with nothing queued.
export const JOBS_NONE = `"jobs.test":
    Get-Jobs:
        attributes-charset (charset) = utf-8
        attributes-natural-language (naturalLanguage) = en
        printer-uri (uri) = ipp://localhost:631/printers/Example_Printer
        which-jobs (keyword) = not-completed
        requesting-user-name (nameWithoutLanguage) = user
    Get jobs                                                             [PASS]
        RECEIVED: 72 bytes in response
        status-code = successful-ok (successful-ok)
        attributes-charset (charset) = utf-8
        attributes-natural-language (naturalLanguage) = en
`;

// Get-Jobs (completed, limit 2): two groups, split by the separator line.
export const JOBS_COMPLETED = `"jobsc.test":
    Get-Jobs:
        attributes-charset (charset) = utf-8
        attributes-natural-language (naturalLanguage) = en
        printer-uri (uri) = ipp://localhost:631/printers/Example_Printer
        which-jobs (keyword) = completed
        limit (integer) = 2
        requesting-user-name (nameWithoutLanguage) = user
    Get completed jobs                                                   [PASS]
        RECEIVED: 573 bytes in response
        status-code = successful-ok (successful-ok)
        attributes-charset (charset) = utf-8
        attributes-natural-language (naturalLanguage) = en
        job-originating-user-name (nameWithoutLanguage) = user
        job-name (nameWithoutLanguage) = Example-Invoice.pdf
        time-at-creation (integer) = 1795782227
        job-id (integer) = 26
        job-state (enum) = completed
        job-state-reasons (keyword) = processing-to-stop-point
        job-media-sheets-completed (integer) = 17
        job-k-octets (integer) = 3617
        -- separator --
        job-originating-user-name (nameWithoutLanguage) = user
        job-name (nameWithoutLanguage) = Example-Letter.pdf
        time-at-creation (integer) = 1795072289
        job-id (integer) = 25
        job-state (enum) = completed
        job-state-reasons (keyword) = processing-to-stop-point
        job-media-sheets-completed (integer) = 1
        job-k-octets (integer) = 88
`;

// Get-Job-Attributes for one job (job 26 above).
export const JOB_ONE = `"jobattr.test":
    Get-Job-Attributes:
        attributes-charset (charset) = utf-8
        attributes-natural-language (naturalLanguage) = en
        job-uri (uri) = ipp://localhost:631/jobs/26
        requested-attributes (1setOf keyword) = job-id,job-state,job-state-reasons,job-name,time-at-creation,job-media-sheets-completed
    Get job attributes                                                   [PASS]
        RECEIVED: 212 bytes in response
        status-code = successful-ok (successful-ok)
        attributes-charset (charset) = utf-8
        attributes-natural-language (naturalLanguage) = en
        time-at-creation (integer) = 1795782227
        job-id (integer) = 26
        job-state (enum) = completed
        job-state-reasons (keyword) = processing-to-stop-point
        job-media-sheets-completed (integer) = 17
`;

// Synthetic: a held job in the shape of JOBS_COMPLETED (no hold was ever sent).
export const JOBS_HELD = `"jobs.test":
    Get-Jobs:
        which-jobs (keyword) = not-completed
    Get jobs                                                             [PASS]
        RECEIVED: 210 bytes in response
        status-code = successful-ok (successful-ok)
        attributes-charset (charset) = utf-8
        attributes-natural-language (naturalLanguage) = en
        job-originating-user-name (nameWithoutLanguage) = user
        job-name (nameWithoutLanguage) = Example-Held.pdf
        time-at-creation (integer) = 1795782300
        job-id (integer) = 27
        job-state (enum) = pending-held
        job-state-reasons (keyword) = job-hold-until-specified
`;
