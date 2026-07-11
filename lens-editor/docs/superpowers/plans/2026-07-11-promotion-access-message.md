# Promotion Access Message Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show a clear admin-token requirement when an ineligible user opens `/promote`.

**Architecture:** Extract the promotion route guard into a focused component that reads the existing auth context. It renders the existing promotion page for eligible admins and a route-specific access message for every rejected case; backend authorization remains unchanged.

**Tech Stack:** React 19, React Router, TypeScript, Vitest, Testing Library

---

### Task 1: Promotion Route Guard

**Files:**
- Create: `lens-editor/src/components/Promotion/PromotionRoute.tsx`
- Create: `lens-editor/src/components/Promotion/PromotionRoute.test.tsx`
- Modify: `lens-editor/src/App.tsx`

- [x] **Step 1: Write failing route-guard tests**

Create tests that mock `PromotionPage`, render `PromotionRoute` inside
`AuthProvider` and `MemoryRouter`, and assert:

```tsx
it('explains that an edit user needs an admin token', () => {
  renderRoute('edit', null, true);
  expect(screen.getByRole('heading', { name: 'Admin access required' })).toBeInTheDocument();
  expect(screen.getByText('You need an admin access token to use production promotion.')).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'Return to editor' })).toHaveAttribute('href', '/');
});

it('rejects an admin token scoped outside Lens Edu', () => {
  renderRoute('admin', 'fbd5eb54-73cc-41b0-ac28-2b93d3b4244e', false);
  expect(screen.getByRole('heading', { name: 'Admin access required' })).toBeInTheDocument();
});

it('renders promotion for an eligible admin', () => {
  renderRoute('admin', null, true);
  expect(screen.getByTestId('promotion-page')).toBeInTheDocument();
});
```

- [x] **Step 2: Run the focused test and verify RED**

Run:

```bash
cd lens-editor && npx vitest run src/components/Promotion/PromotionRoute.test.tsx
```

Expected: FAIL because `PromotionRoute.tsx` does not exist.

- [x] **Step 3: Implement the route guard and access view**

Create `PromotionRoute.tsx` with this behavior:

```tsx
export function PromotionRoute() {
  const { canPromote, folderUuid, isAllFolders } = useAuth();
  const hasFolderAccess = isAllFolders || folderUuid === EDU_FOLDER_ID;

  if (canPromote && hasFolderAccess) return <PromotionPage />;

  return (
    <main className="h-full bg-gray-50 flex items-center justify-center">
      <div className="max-w-md px-6 text-center">
        <h1 className="text-2xl font-semibold text-gray-900">Admin access required</h1>
        <p className="mt-2 text-gray-600">
          You need an admin access token to use production promotion.
        </p>
        <Link to="/" className="mt-4 inline-block text-sm text-blue-600 underline hover:text-blue-800">
          Return to editor
        </Link>
      </div>
    </main>
  );
}
```

Replace the conditional `/promote` route element in `App.tsx` with
`<PromotionRoute />`, remove the direct `PromotionPage` import, and retain
`canPromote` where it is still used elsewhere in `App.tsx`.

- [x] **Step 4: Run focused tests and verify GREEN**

Run:

```bash
cd lens-editor && npx vitest run src/components/Promotion/PromotionRoute.test.tsx
```

Expected: 3 tests pass.

- [x] **Step 5: Run related tests and production build**

Run:

```bash
cd lens-editor && npx vitest run src/components/Promotion src/contexts/AuthContext.test.tsx
npm run build
```

Expected: all selected tests pass and the TypeScript/Vite production build exits successfully.

- [x] **Step 6: Verify the route manually**

Start the workspace stack on ports 8090 and 5173, open an edit-token URL at
`http://dev.vps:5173/promote`, and confirm the admin-access message is visible.
Open an admin-token URL and confirm the promotion page still loads.

- [x] **Step 7: Record the completed change**

Run:

```bash
jj st
jj describe -m "fix: explain promotion admin access requirement"
```

Expected: only the planned promotion route, tests, spec, and plan are present in the working change.
