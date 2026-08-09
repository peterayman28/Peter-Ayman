/**
 * Gift Guide section behaviour — a two-stage product quick view.
 *
 * Stage 1: clicking a product image reveals a small preview card layered on top
 *          of that image (thumbnail, title, price, close button).
 * Stage 2: clicking that preview card opens a centred <dialog> quick view with
 *          the larger image, description, colour swatches, size dropdown and an
 *          AJAX add-to-cart.
 *
 * Liquid owns all structure and product data (see sections/gift-guide.liquid).
 * This module only toggles visibility, resolves the selected variant from the
 * option controls already in the DOM, and talks to the Cart AJAX API. There is
 * no client-side templating and no third-party library.
 */

import { Component } from '@theme/component';
import { fetchConfig } from '@theme/utilities';
import { CartLinesUpdateEvent } from '@shopify/events';

/** How long the "Added ✓" confirmation stays on the add-to-cart button (ms). */
const ADDED_STATE_DURATION = 2000;

/**
 * A single purchasable variant, as serialised by the section's Liquid.
 *
 * @typedef {object} GiftGuideVariant
 * @property {number} id - The variant id, posted to /cart/add.js.
 * @property {string | null} color - Value of the "Color" option, or null if the product has none.
 * @property {string | null} size - Value of the "Size" option, or null if the product has none.
 * @property {boolean} available - Whether the variant can currently be purchased.
 * @property {string} price - The pre-formatted price (money filter output).
 */

/**
 * @typedef {object} GiftGuideRefs
 * @property {HTMLElement[]} [previews] - Stage 1 preview cards, in grid order.
 * @property {HTMLDialogElement[]} [quickViews] - Stage 2 dialogs, in grid order.
 *
 * @extends {Component<GiftGuideRefs>}
 */
class GiftGuideComponent extends Component {
  /**
   * Index of the stage 1 preview that is currently open, or null when none is.
   * @type {number | null}
   */
  #openPreviewIndex = null;

  /**
   * Parsed variant data per product index, populated on first use.
   * @type {Map<number, GiftGuideVariant[]>}
   */
  #variantCache = new Map();

  /**
   * Pending "Added ✓" reset timers, keyed by product index.
   * @type {Map<number, number>}
   */
  #addedTimeouts = new Map();

  connectedCallback() {
    super.connectedCallback();

    // Clicking anywhere outside a product cell dismisses the stage 1 preview.
    document.addEventListener('click', this.#handleDocumentClick);
    document.addEventListener('keydown', this.#handleKeydown);

    // A native <dialog> reports backdrop clicks as clicks on the dialog itself.
    // These are wired directly rather than with `on:click`, because the
    // delegated handler rewrites event.target and the distinction would be lost.
    for (const dialog of this.#quickViews) {
      dialog.addEventListener('click', this.#handleDialogClick);
      dialog.addEventListener('close', this.#handleDialogClose);
    }
  }

  disconnectedCallback() {
    super.disconnectedCallback();

    document.removeEventListener('click', this.#handleDocumentClick);
    document.removeEventListener('keydown', this.#handleKeydown);

    for (const dialog of this.#quickViews) {
      dialog.removeEventListener('click', this.#handleDialogClick);
      dialog.removeEventListener('close', this.#handleDialogClose);
    }

    for (const timeout of this.#addedTimeouts.values()) clearTimeout(timeout);
    this.#addedTimeouts.clear();
  }

  /** @returns {HTMLElement[]} The stage 1 preview cards. */
  get #previews() {
    return this.refs.previews ?? [];
  }

  /** @returns {HTMLDialogElement[]} The stage 2 quick view dialogs. */
  get #quickViews() {
    return this.refs.quickViews ?? [];
  }

  /* ------------------------------------------------------------------ *
   * Stage 1 — the small preview layered over the grid image
   * ------------------------------------------------------------------ */

  /**
   * Opens the preview for a product, closing any other that was open.
   *
   * @param {{ index: number }} data - Parsed from the `on:click` attribute.
   */
  openPreview({ index }) {
    this.#closeAllPreviews();

    const preview = this.#previews[index];
    if (!preview) return;

    preview.hidden = false;
    this.#openPreviewIndex = index;

    // Move focus into the preview so keyboard users land on the new content.
    const focusable = preview.querySelector('[data-gift-guide-expand]');
    if (focusable instanceof HTMLElement) focusable.focus();
  }

  /**
   * Closes a preview without opening the quick view.
   *
   * @param {{ index: number }} data - Parsed from the `on:click` attribute.
   * @param {MouseEvent} event - The originating click.
   */
  closePreview({ index }, event) {
    // The close button is a sibling of the card that opens stage 2, but stop
    // propagation anyway so an overlapping hit area can never open the dialog.
    event.stopPropagation();
    this.#closeAllPreviews();

    // Return focus to the grid image the preview belonged to.
    const trigger = this.querySelector(`[data-gift-guide-trigger="${index}"]`);
    if (trigger instanceof HTMLElement) trigger.focus();
  }

  /** Hides every stage 1 preview. */
  #closeAllPreviews() {
    for (const preview of this.#previews) preview.hidden = true;
    this.#openPreviewIndex = null;
  }

  /* ------------------------------------------------------------------ *
   * Stage 2 — the centred quick view dialog
   * ------------------------------------------------------------------ */

  /**
   * Expands a preview into the full quick view dialog.
   *
   * @param {{ index: number }} data - Parsed from the `on:click` attribute.
   */
  openQuickView({ index }) {
    const dialog = this.#quickViews[index];
    if (!dialog) return;

    this.#closeAllPreviews();
    this.#syncQuickView(index);

    // showModal() puts the dialog in the top layer, so it escapes any ancestor
    // overflow or stacking context, and gives us Esc-to-close and a focus trap.
    dialog.showModal();
  }

  /**
   * Closes the quick view dialog.
   *
   * @param {{ index: number }} data - Parsed from the `on:click` attribute.
   */
  closeQuickView({ index }) {
    this.#quickViews[index]?.close();
  }

  /**
   * Selects a colour swatch and re-resolves the matching variant.
   *
   * @param {{ index: number }} data - Parsed from the `on:click` attribute.
   * @param {MouseEvent & { target: HTMLElement }} event - The originating click.
   */
  selectColor({ index }, event) {
    const dialog = this.#quickViews[index];
    const swatch = event.target;
    if (!dialog || !(swatch instanceof HTMLElement)) return;

    for (const option of dialog.querySelectorAll('[data-gift-guide-swatch]')) {
      option.setAttribute('aria-pressed', String(option === swatch));
    }

    this.#syncQuickView(index);
  }

  /**
   * Handles a size dropdown change.
   *
   * @param {{ index: number }} data - Parsed from the `on:change` attribute.
   */
  selectSize({ index }) {
    this.#syncQuickView(index);
  }

  /* ------------------------------------------------------------------ *
   * Variant resolution
   * ------------------------------------------------------------------ */

  /**
   * Reads (and caches) the variant data Liquid embedded in a dialog.
   *
   * @param {number} index - The product's position in the grid.
   * @returns {GiftGuideVariant[]} The product's variants.
   */
  #variants(index) {
    const cached = this.#variantCache.get(index);
    if (cached) return cached;

    const source = this.#quickViews[index]?.querySelector('[data-gift-guide-variants]');
    /** @type {GiftGuideVariant[]} */
    let variants = [];

    try {
      variants = JSON.parse(source?.textContent ?? '[]');
    } catch (error) {
      console.error('[gift-guide] Could not parse variant data', error);
    }

    this.#variantCache.set(index, variants);
    return variants;
  }

  /**
   * Finds the variant matching the currently selected options. Options the
   * product does not have are serialised as null and therefore ignored.
   *
   * @param {number} index - The product's position in the grid.
   * @returns {GiftGuideVariant | null} The matching variant, if any.
   */
  #resolveVariant(index) {
    const dialog = this.#quickViews[index];
    if (!dialog) return null;

    const selectedSwatch = dialog.querySelector('[data-gift-guide-swatch][aria-pressed="true"]');
    const color = selectedSwatch instanceof HTMLElement ? (selectedSwatch.dataset.value ?? null) : null;

    const sizeSelect = dialog.querySelector('[data-gift-guide-size]');
    const size = sizeSelect instanceof HTMLSelectElement ? sizeSelect.value : null;

    return (
      this.#variants(index).find(
        (variant) =>
          (color === null || variant.color === color) && (size === null || variant.size === size)
      ) ?? null
    );
  }

  /**
   * Reflects the resolved variant in the dialog: price, and whether the
   * add-to-cart button is purchasable.
   *
   * @param {number} index - The product's position in the grid.
   */
  #syncQuickView(index) {
    const dialog = this.#quickViews[index];
    if (!dialog) return;

    const variant = this.#resolveVariant(index);
    const price = dialog.querySelector('[data-gift-guide-price]');
    const button = dialog.querySelector('[data-gift-guide-add]');

    if (price && variant) price.textContent = variant.price;
    if (!(button instanceof HTMLButtonElement)) return;

    const label = button.querySelector('[data-gift-guide-add-label]');
    const purchasable = Boolean(variant?.available);

    button.disabled = !purchasable;

    // Leave an in-flight "Added ✓" confirmation alone; it restores itself.
    if (this.#addedTimeouts.has(index) || !label) return;

    label.textContent = purchasable
      ? (button.dataset.defaultLabel ?? '')
      : variant
        ? (button.dataset.soldOutLabel ?? '')
        : (button.dataset.unavailableLabel ?? '');
  }

  /* ------------------------------------------------------------------ *
   * Add to cart
   * ------------------------------------------------------------------ */

  /**
   * Adds the selected variant to the cart without a page reload, then shows a
   * brief success state. The theme's cart drawer, cart icon and line items all
   * listen for CartLinesUpdateEvent, so dispatching it keeps them in sync.
   *
   * @param {{ index: number }} data - Parsed from the `on:submit` attribute.
   * @param {SubmitEvent} event - The form submission.
   */
  async addToCart({ index }, event) {
    event.preventDefault();

    const dialog = this.#quickViews[index];
    const variant = this.#resolveVariant(index);
    const button = dialog?.querySelector('[data-gift-guide-add]');

    if (!variant?.available || !(button instanceof HTMLButtonElement)) return;

    const body = new FormData();
    body.set('id', String(variant.id));
    body.set('quantity', '1');

    // Announce the pending change up front, with a promise the listeners await.
    const deferred = CartLinesUpdateEvent.createPromise();

    this.dispatchEvent(
      new CartLinesUpdateEvent({
        action: 'add',
        context: 'product',
        lines: [{ merchandiseId: String(variant.id), quantity: 1 }],
        promise: deferred.promise,
      })
    );

    button.disabled = true;

    try {
      const response = await fetch(Theme.routes.cart_add_url, fetchConfig('javascript', { body }));
      const result = await response.json();

      // The Cart AJAX API reports failures with a `status` field, not an HTTP error.
      if (result.status) throw new Error(result.description || result.message || 'Add to cart failed');

      // Re-read the cart so listeners get an authoritative total quantity.
      const cart = await (await fetch(`${Theme.routes.cart_url}.js`)).json();

      deferred.resolve({
        cart: CartLinesUpdateEvent.createCartFromAjaxResponse(cart),
        detail: {
          items: cart.items,
          source: 'gift-guide-component',
          sourceId: this.id,
          itemCount: 1,
        },
      });

      this.#showAddedState(index, button);
    } catch (error) {
      deferred.reject(error);
      console.error('[gift-guide] Add to cart failed', error);

      const label = button.querySelector('[data-gift-guide-add-label]');
      if (label) label.textContent = button.dataset.errorLabel ?? '';
      this.#restoreLabelAfterDelay(index, button);
    } finally {
      button.disabled = false;
    }
  }

  /**
   * Swaps the button label to the success state for a couple of seconds.
   *
   * @param {number} index - The product's position in the grid.
   * @param {HTMLButtonElement} button - The add-to-cart button.
   */
  #showAddedState(index, button) {
    const label = button.querySelector('[data-gift-guide-add-label]');
    if (label) label.textContent = button.dataset.addedLabel ?? '';

    button.classList.add('gift-guide__add--added');
    this.#restoreLabelAfterDelay(index, button);
  }

  /**
   * Restores the button's default label after ADDED_STATE_DURATION.
   *
   * @param {number} index - The product's position in the grid.
   * @param {HTMLButtonElement} button - The add-to-cart button.
   */
  #restoreLabelAfterDelay(index, button) {
    clearTimeout(this.#addedTimeouts.get(index));

    const timeout = setTimeout(() => {
      this.#addedTimeouts.delete(index);
      button.classList.remove('gift-guide__add--added');
      this.#syncQuickView(index);
    }, ADDED_STATE_DURATION);

    this.#addedTimeouts.set(index, timeout);
  }

  /* ------------------------------------------------------------------ *
   * Dismissal
   * ------------------------------------------------------------------ */

  /**
   * Dismisses the stage 1 preview when the click lands outside any product
   * cell. Clicks inside a cell are left to that cell's own handlers, so a
   * click that opens one preview is never treated as an outside click.
   *
   * @param {MouseEvent} event - The document click.
   */
  #handleDocumentClick = (event) => {
    if (this.#openPreviewIndex === null) return;
    if (!(event.target instanceof Element)) return;

    const cell = event.target.closest('.gift-guide__cell');
    if (cell && this.contains(cell)) return;

    this.#closeAllPreviews();
  };

  /**
   * Closes an open stage 1 preview on Escape. The quick view is a native modal
   * dialog, so the browser already handles Escape there.
   *
   * @param {KeyboardEvent} event - The keydown.
   */
  #handleKeydown = (event) => {
    if (event.key !== 'Escape' || this.#openPreviewIndex === null) return;

    const index = this.#openPreviewIndex;
    this.#closeAllPreviews();

    const trigger = this.querySelector(`[data-gift-guide-trigger="${index}"]`);
    if (trigger instanceof HTMLElement) trigger.focus();
  };

  /**
   * Closes the quick view when the backdrop is clicked. A click on the padding
   * of a modal <dialog> targets the dialog element itself.
   *
   * @param {MouseEvent} event - The click inside the dialog.
   */
  #handleDialogClick = (event) => {
    if (event.target instanceof HTMLDialogElement) event.target.close();
  };

  /**
   * Returns focus to the grid image once the dialog closes, however it closed.
   *
   * @param {Event} event - The dialog's close event.
   */
  #handleDialogClose = (event) => {
    const dialog = event.currentTarget;
    if (!(dialog instanceof HTMLDialogElement)) return;

    const trigger = this.querySelector(`[data-gift-guide-trigger="${dialog.dataset.index}"]`);
    if (trigger instanceof HTMLElement) trigger.focus();
  };
}

if (!customElements.get('gift-guide-component')) {
  customElements.define('gift-guide-component', GiftGuideComponent);
}
