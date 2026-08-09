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
      dialog.addEventListener('cancel', this.#handleDialogCancel);
    }
  }

  disconnectedCallback() {
    super.disconnectedCallback();

    document.removeEventListener('click', this.#handleDocumentClick);
    document.removeEventListener('keydown', this.#handleKeydown);

    for (const dialog of this.#quickViews) {
      dialog.removeEventListener('click', this.#handleDialogClick);
      dialog.removeEventListener('close', this.#handleDialogClose);
      dialog.removeEventListener('cancel', this.#handleDialogCancel);
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

    const options = /** @type {HTMLElement[]} */ ([...dialog.querySelectorAll('[data-gift-guide-swatch]')]);
    const previous = options.findIndex((option) => option.getAttribute('aria-pressed') === 'true');
    const next = options.indexOf(swatch);

    if (next === -1 || next === previous) return;

    const select = () => {
      for (const option of options) option.setAttribute('aria-pressed', String(option === swatch));
    };

    if (previous === -1) {
      // Nothing was selected, so there is no journey to animate: apply the fill
      // immediately. Suppressing the transition needs the "none" to be in
      // effect before the transform changes, hence the forced reflows.
      for (const option of options) option.setAttribute('data-instant', '');
      void swatch.offsetWidth;
      select();
      void swatch.offsetWidth;
      for (const option of options) option.removeAttribute('data-instant');
    } else {
      // Moving between colours: the outgoing fill retreats and the incoming one
      // grows from the facing edge, so the two read as a single movement.
      const movingRight = next > previous;
      options[previous]?.style.setProperty('--gg-fill-origin', movingRight ? 'right' : 'left');
      swatch.style.setProperty('--gg-fill-origin', movingRight ? 'left' : 'right');
      select();
    }

    this.#clearError(index);
    this.#syncQuickView(index);
  }

  /**
   * @param {number} index - The product's position in the grid.
   * @returns {boolean} Whether this product has a Color option at all.
   */
  #hasColorOptions(index) {
    return Boolean(this.#quickViews[index]?.querySelector('[data-gift-guide-swatch]'));
  }

  /**
   * @param {number} index - The product's position in the grid.
   * @returns {string | null} The chosen colour, or null while none is selected.
   */
  #selectedColor(index) {
    const selected = this.#quickViews[index]?.querySelector('[data-gift-guide-swatch][aria-pressed="true"]');
    return selected instanceof HTMLElement ? (selected.dataset.value ?? null) : null;
  }

  /**
   * Reports the first option the shopper still has to choose. Nothing is
   * preselected, so this drives the validation on add-to-cart.
   *
   * @param {number} index - The product's position in the grid.
   * @returns {'color' | 'size' | null} The outstanding choice, if any.
   */
  #missingChoice(index) {
    if (this.#hasColorOptions(index) && this.#selectedColor(index) === null) return 'color';
    if (this.#hasSizeOptions(index) && this.#selectedSize(index) === null) return 'size';
    return null;
  }

  /**
   * Shows (or with an empty message, hides) the inline validation message.
   *
   * @param {number} index - The product's position in the grid.
   * @param {string} message - The message to display.
   */
  #setError(index, message) {
    const error = this.#quickViews[index]?.querySelector('[data-gift-guide-error]');
    if (!(error instanceof HTMLElement)) return;

    error.textContent = message;
    error.hidden = !message;
  }

  /** @param {number} index - The product's position in the grid. */
  #clearError(index) {
    this.#setError(index, '');
  }

  /* ------------------------------------------------------------------ *
   * Size: a custom listbox standing in for a native <select>
   * ------------------------------------------------------------------ */

  /**
   * @param {number} index - The product's position in the grid.
   * @returns {Element | null} The size dropdown wrapper, if the product has sizes.
   */
  #sizeDropdown(index) {
    return this.#quickViews[index]?.querySelector('[data-gift-guide-size]') ?? null;
  }

  /**
   * @param {number} index - The product's position in the grid.
   * @returns {boolean} Whether this product has a Size option at all.
   */
  #hasSizeOptions(index) {
    return this.#sizeDropdown(index) !== null;
  }

  /**
   * @param {number} index - The product's position in the grid.
   * @returns {string | null} The chosen size, or null while the placeholder shows.
   */
  #selectedSize(index) {
    const selected = this.#sizeDropdown(index)?.querySelector('[role="option"][aria-selected="true"]');
    return selected instanceof HTMLElement ? (selected.dataset.value ?? null) : null;
  }

  /**
   * @param {number} index - The product's position in the grid.
   * @returns {HTMLElement[]} The size option rows.
   */
  #sizeOptions(index) {
    const options = this.#sizeDropdown(index)?.querySelectorAll('[role="option"]') ?? [];
    return /** @type {HTMLElement[]} */ ([...options]);
  }

  /**
   * @param {number} index - The product's position in the grid.
   * @returns {HTMLElement | null} The button that opens the listbox.
   */
  #sizeTrigger(index) {
    const trigger = this.#sizeDropdown(index)?.querySelector('[data-gift-guide-size-trigger]');
    return trigger instanceof HTMLElement ? trigger : null;
  }

  /**
   * @param {number} index - The product's position in the grid.
   * @returns {boolean} Whether the listbox is currently expanded.
   */
  #sizeMenuOpen(index) {
    return this.#sizeTrigger(index)?.getAttribute('aria-expanded') === 'true';
  }

  /**
   * Opens or closes the size listbox.
   *
   * @param {{ index: number }} data - Parsed from the `on:click` attribute.
   */
  toggleSizeMenu({ index }) {
    if (this.#sizeMenuOpen(index)) this.#closeSizeMenu(index);
    else this.#openSizeMenu(index);
  }

  /**
   * Expands the listbox and moves focus to the selected row, or the first.
   *
   * @param {number} index - The product's position in the grid.
   */
  #openSizeMenu(index) {
    const trigger = this.#sizeTrigger(index);
    const list = this.#sizeDropdown(index)?.querySelector('[role="listbox"]');
    if (!trigger || !(list instanceof HTMLElement)) return;

    trigger.setAttribute('aria-expanded', 'true');
    list.hidden = false;

    // No measuring needed: the drawer sits in normal flow, so the popup grows
    // to fit it and CSS max-height caps it. Measuring against the popup clipped
    // it to ~2.5 rows; measuring against the viewport let it escape the popup's
    // border. Neither problem exists once it is in flow.
    const options = this.#sizeOptions(index);
    const selected = options.find((option) => option.getAttribute('aria-selected') === 'true');
    (selected ?? options[0])?.focus();
  }

  /**
   * Collapses the listbox.
   *
   * @param {number} index - The product's position in the grid.
   * @param {object} [options] - Options.
   * @param {boolean} [options.focusTrigger] - Whether to return focus to the trigger.
   */
  #closeSizeMenu(index, { focusTrigger = false } = {}) {
    const trigger = this.#sizeTrigger(index);
    const list = this.#sizeDropdown(index)?.querySelector('[role="listbox"]');
    if (!trigger || !(list instanceof HTMLElement)) return;

    trigger.setAttribute('aria-expanded', 'false');
    list.hidden = true;

    if (focusTrigger) trigger.focus();
  }

  /**
   * Handles a click on a size option row.
   *
   * @param {{ index: number }} data - Parsed from the `on:click` attribute.
   * @param {MouseEvent & { target: HTMLElement }} event - The originating click.
   */
  selectSize({ index }, event) {
    if (event.target instanceof HTMLElement) this.#applySize(index, event.target);
  }

  /**
   * Marks a size as selected, updates the trigger text, and collapses the list.
   *
   * @param {number} index - The product's position in the grid.
   * @param {HTMLElement} chosen - The chosen option row.
   */
  #applySize(index, chosen) {
    for (const option of this.#sizeOptions(index)) {
      option.setAttribute('aria-selected', String(option === chosen));
    }

    const value = this.#sizeDropdown(index)?.querySelector('[data-gift-guide-size-value]');
    if (value) value.textContent = chosen.dataset.value ?? '';

    this.#closeSizeMenu(index, { focusTrigger: true });
    this.#clearError(index);
    this.#syncQuickView(index);
  }

  /**
   * Keyboard support for the listbox, per the ARIA authoring practices.
   * Bound on the wrapper, so it covers both the trigger and the option rows.
   *
   * Note the preventDefault() calls on Enter/Space: without them the browser
   * would also fire the trigger button's native click and immediately undo
   * whatever this handler just did.
   *
   * @param {{ index: number }} data - Parsed from the `on:keydown` attribute.
   * @param {KeyboardEvent} event - The keydown.
   */
  sizeKeydown({ index }, event) {
    const options = this.#sizeOptions(index);
    if (!options.length) return;

    const expanded = this.#sizeMenuOpen(index);
    const active = options.indexOf(/** @type {HTMLElement} */ (document.activeElement));

    switch (event.key) {
      case 'ArrowDown':
      case 'ArrowUp': {
        event.preventDefault();
        if (!expanded) return this.#openSizeMenu(index);

        const step = event.key === 'ArrowDown' ? 1 : -1;
        const next = active === -1 ? 0 : (active + step + options.length) % options.length;
        options[next]?.focus();
        return;
      }

      case 'Home':
      case 'End': {
        if (!expanded) return;
        event.preventDefault();
        (event.key === 'Home' ? options[0] : options[options.length - 1])?.focus();
        return;
      }

      case 'Enter':
      case ' ': {
        event.preventDefault();
        if (!expanded) return this.#openSizeMenu(index);

        const option = options[active];
        if (option) this.#applySize(index, option);
        else this.#closeSizeMenu(index, { focusTrigger: true });
        return;
      }

      /* Escape is handled by #handleDialogCancel, not here. The browser turns
       * it into a close request on the dialog; if this handler collapsed the
       * menu first, that request would then close the dialog too. */

      case 'Tab':
        if (expanded) this.#closeSizeMenu(index);
    }
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

    const color = this.#selectedColor(index);
    const size = this.#selectedSize(index);

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
    const awaitingChoice = this.#missingChoice(index) !== null;

    // While a choice is outstanding the button stays enabled, so clicking it
    // surfaces the validation message rather than doing nothing at all.
    button.disabled = !awaitingChoice && !purchasable;

    // Leave an in-flight "Added ✓" confirmation alone; it restores itself.
    if (this.#addedTimeouts.has(index) || !label) return;

    label.textContent =
      awaitingChoice || purchasable
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
    const button = dialog?.querySelector('[data-gift-guide-add]');
    if (!(button instanceof HTMLButtonElement)) return;

    // Nothing is preselected, so validate here rather than leaving the shopper
    // with a button that silently does nothing.
    const missing = this.#missingChoice(index);
    if (missing) {
      const message =
        missing === 'color' ? button.dataset.colorRequiredLabel : button.dataset.sizeRequiredLabel;
      this.#setError(index, message ?? '');
      return;
    }

    this.#clearError(index);

    const variant = this.#resolveVariant(index);
    if (!variant?.available) return;

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
    if (event.target instanceof HTMLDialogElement) {
      event.target.close();
      return;
    }

    // A click anywhere else inside the dialog dismisses an open size menu.
    const dialog = event.currentTarget;
    if (!(event.target instanceof Element) || !(dialog instanceof HTMLDialogElement)) return;
    if (!event.target.closest('[data-gift-guide-size]')) {
      this.#closeSizeMenu(Number(dialog.dataset.index));
    }
  };

  /**
   * Intercepts the browser's close request (Escape) so that when the size menu
   * is open, Escape collapses the menu instead of closing the whole dialog.
   *
   * @param {Event} event - The dialog's cancel event.
   */
  #handleDialogCancel = (event) => {
    const dialog = event.currentTarget;
    if (!(dialog instanceof HTMLDialogElement)) return;

    const index = Number(dialog.dataset.index);
    if (!this.#sizeMenuOpen(index)) return;

    event.preventDefault();
    this.#closeSizeMenu(index, { focusTrigger: true });
  };

  /**
   * Returns focus to the grid image once the dialog closes, however it closed.
   *
   * @param {Event} event - The dialog's close event.
   */
  #handleDialogClose = (event) => {
    const dialog = event.currentTarget;
    if (!(dialog instanceof HTMLDialogElement)) return;

    // Leave the size menu collapsed for the next time this dialog opens.
    this.#closeSizeMenu(Number(dialog.dataset.index));

    const trigger = this.querySelector(`[data-gift-guide-trigger="${dialog.dataset.index}"]`);
    if (trigger instanceof HTMLElement) trigger.focus();
  };
}

if (!customElements.get('gift-guide-component')) {
  customElements.define('gift-guide-component', GiftGuideComponent);
}
