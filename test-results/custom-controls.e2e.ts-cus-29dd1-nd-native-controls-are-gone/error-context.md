# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: custom-controls.e2e.ts >> custom bar renders and native controls are gone
- Location: tests/e2e/custom-controls.e2e.ts:6:1

# Error details

```
Error: expect(locator).not.toHaveAttribute(expected) failed

Locator: locator('video')
Expected pattern: not /.*/
Received string: ""

Call log:
  - Expect "not toHaveAttribute" with timeout 10000ms
  - waiting for locator('video')

```

```
Error: browserContext.close: Target page, context or browser has been closed
```