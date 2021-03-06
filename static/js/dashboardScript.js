'use strict';

// Track whether or not Web3 was able to be initialized.
let hasValidWeb3 = false;

// Store our access token as a constant.
let GAME_TOKEN;
let USER_ADDRESS;

// Track the list of game items which can be ascended.
let gameItems = [];

// Track the pending orders for item ascension.
let ascensionItems = {};

// Track the pending orders for items to purchase.
let checkoutItems = {};

// Debounce refreshing the module interfaces.
let linkedToEnjin = false;

// Debounce checkout cart content updates.
let previousCartContent = '';

// A helper function to show an error message on the page.
function showError (errorMessage) {
	let errorBox = $('#errorBox');
	errorBox.html(errorMessage);
	errorBox.show();
};

// A helper function to show a status message on the page.
function showStatusMessage (statusMessage) {
	let messageBox = $('#messageBox');
	messageBox.html(statusMessage);
	messageBox.show();
};

// A helper function to format a string message.
function formatString (formatString, variables) {
	for (let i = 0; i < variables.length; i++) {
		formatString = formatString.replace(`{${i}}`, variables[i]);
	}
	return formatString;
};

// Initialize the shopping cart to begin accepting additional services.
let fetchedDiscount = false;
let discountMultiplier = 1.00;
async function initializeCart (shoppingCart) {
	let cartOffersResponse = await $.post('/sales', { serviceIdFilter: Object.keys(shoppingCart) });
	if (cartOffersResponse.status === 'SUCCESS') {
		let cartOffers = cartOffersResponse.offers;

		// If the user has no in-stock items in their shopping cart, we can't display anything.
		if (cartOffers.length === 0) {
			$('#checkout-cart-container').html('There are no in-stock items in your cart.');

		// Otherwise, if there are items in stock, create the cart and display them.
		} else {
			if (window.serverData.discountTokenEnabled) {
				if (!fetchedDiscount) {
					fetchedDiscount = true;
					let discountResponse = await $.post('/get-discount', { address: USER_ADDRESS });
					if (discountResponse.status === 'SUCCESS') {
						let discount = discountResponse.discount;
						discountMultiplier = (1 - (discount / 100.0));
						let discountTokenMessage = formatString(window.serverData.discountTokenMessage, [ `${discount.toFixed(2)}%` ]);
						$('#checkout-cart-title').html(`Your Checkout Cart; ${discountTokenMessage}`);

					// Otherwise, display an error from the server.
					} else if (discountResponse.status === 'ERROR') {
						let errorBox = $('#errorBox');
						errorBox.html(discountResponse.message);
						errorBox.show();

					// Otherwise, display an error about an unknown status.
					} else {
						let errorBox = $('#errorBox');
						errorBox.html('Received unknown message status from the server.');
						errorBox.show();
					}
				}
			}

			let cartContent =
			`<table id="cart" class="table table-hover table-condensed">
		    <thead>
		      <tr>
		        <th style="width:50%">Product</th>
		        <th style="width:10%">Price</th>
		        <th style="width:8%">Quantity</th>
		        <th style="width:22%" class="text-center">Subtotal</th>
		        <th style="width:10%"></th>
		      </tr>
		    </thead>
		    <tbody id="cartBodyContents">
		    </tbody>
		    <tfoot>
		      <tr id="cart-checkout-row">
		        <td class="col-sm-3 hidden-xs text-center">
		          <strong id="checkout-total">Total $0.00</strong>
		        </td>
		      </tr>
		    </tfoot>
		  </table>`;
			$('#checkout-cart-container').html(cartContent);

			// Prepare the available payment options that are enabled for checkout.
			let purchaseMethodsContent = '';
			if (window.serverData.paypalEnabled) {
				purchaseMethodsContent +=
				`<!-- Only embed the PayPal checkout script if PayPal is enabled. -->
				<td class="col-sm-3">
					<div id="paypal-button-container"></div>
				</td>`;
			}
			if (window.serverData.etherEnabled && hasValidWeb3) {
				purchaseMethodsContent +=
				`<td class="col-sm-3">
					<button id="payWithEther" type="button" class="btn btn-primary">Pay with ETH</button>
				</td>`;
			}

			// Add the payment checkout options.
			$('#cart-checkout-row').append(purchaseMethodsContent);

			// If enabled, embed the PayPal script into the page; we must disable cache-busting to make this possible.
			if (window.serverData.paypalEnabled) {
				$.ajaxSetup({
					cache: true
				});
				$.getScript(`https://www.paypal.com/sdk/js?client-id=${window.serverData.paypalClientId}`, function () {
					preparePayPalButtons();
				});
			}

			// If enabled, show the checkout cart's Ether payment button.
			if (window.serverData.etherEnabled && hasValidWeb3) {
				await prepareEtherButton();
			}

			for (let i = 0; i < cartOffers.length; i++) {
				let service = cartOffers[i];
				let serviceId = service.serviceId;
				let amount = shoppingCart[serviceId];
				checkoutItems[serviceId] = amount;

				// Add the service details to the checkout cart.
				let serviceName = service.serviceMetadata.name;
				let serviceDescription = service.serviceMetadata.description;
				await addItemToCart(service, amount);

				// Create a modal detailing this service which can be opened later.
				let modalContent =
				`<div class="modal fade" id="bundle-modal-${serviceId}" tabindex="-1" role="dialog" aria-labelledby="exampleModalCenterTitle" aria-hidden="true">
					<div class="modal-dialog modal-dialog-centered" role="document">
						<div class="modal-content">
							<div class="modal-header">
								<h5 class="modal-title">${serviceName}</h5>
								<button type="button" class="close" data-dismiss="modal" aria-label="Close">
									<span aria-hidden="true">&times;</span>
								</button>
							</div>
							<div id="bundle-modal-body-${serviceId}" class="modal-body">
							</div>
						</div>
					</div>
				</div>`;
				$('#bundle-modal-container').append(modalContent);

				// Fill out the details for what exactly is contained within this service.
				let bundleContentsBody =
				`<p>${serviceDescription}</p>`;
				let serviceContents = service.contents;
				for (let j = 0; j < serviceContents.length; j++) {
					let item = serviceContents[j];
					let itemId = item.itemId;
					let itemAmount = item.amount;
					let itemStock = item.availableForPurchase;
					let itemName = item.metadata.name;
					let itemImage = item.metadata.image;
					let itemDescription = item.metadata.description;
					let itemEntry =
					`<div class="row">
						<div class="col-sm-3 hidden-xs">
							<img src="${itemImage}" alt="${itemName}" class="img-responsive" height="100" width="100"/>
						</div>
						<div class="col-sm-9">
							<h4 class="nomargin">${itemAmount} x ${itemName} (${itemId})</h4>
							<p>${itemDescription}</p>
							<p>There are ${itemStock} of this item left in stock.</p>
						</div>
					</div>`;
					// TODO: make the text there match ordinals for the amount left in stock.
					bundleContentsBody += itemEntry;

					// If we choose to show out of stock services, flag them as such.
					if (!window.serverData.hideOutOfStockItems && itemStock <= 0) {
						$(`#quantityInput-${serviceId}`).attr('value', 0);
						$(`#quantityInput-${serviceId}`).attr('servicePrice', 0);
						$(`#service-price-display-${serviceId}`).html(`$${0}`);
						$(`#subtotal-${serviceId}`).html(`$${0}`);
						$(`#service-description-${serviceId}`).html(`Unfortunately, this service is out of stock.`);
						await refreshCart();
					}
				}
				$(`#bundle-modal-body-${serviceId}`).html(bundleContentsBody);
			}

			// Assign delegate to open a modal when clicking on a bundle.
			$('#cartBodyContents').on('click', '.checkout-service-row', async function (changedEvent) {
				if (!$(changedEvent.target).hasClass('checkout-quantity-selector') && !$(changedEvent.target).hasClass('checkout-deletion')) {
					let serviceId = $(this).attr('serviceId');
					$(`#bundle-modal-${serviceId}`).modal();
				}
			});

			// Assigning delegate to checkout cart quantity selection event handler.
			$('#cartBodyContents').on('input', '.checkout-quantity-selector', async function (changedEvent) {
				changedEvent.stopPropagation();
				let quantity = parseInt($(this).val());
				let serviceId = $(this).attr('serviceId');
				let servicePrice = $(this).attr('servicePrice');
				let subtotal = (quantity * servicePrice).toFixed(2);
				$(`#subtotal-${serviceId}`).html(`$${subtotal}`);
				checkoutItems[serviceId] = quantity;

				// Manipulate the shopping cart cookie to update the quantity of this chosen service.
				let shoppingCookie = Cookies.get(window.serverData.checkoutCookieName);
				if (shoppingCookie) {
					let shoppingCart = JSON.parse(shoppingCookie);
					if (shoppingCart) {
						shoppingCart[serviceId] = quantity;
						Cookies.set(window.serverData.checkoutCookieName, JSON.stringify(shoppingCart), { expires: 1, path: '/', domain: window.serverData.checkoutCookieDomain, secure: false, sameSite: 'lax' });
					}
				}
				await refreshCart();
			});

			// Assigning delegate to checkout cart deletion event handler.
			$('#cartBodyContents').on('click', '.checkout-deletion', async function (changedEvent) {
				changedEvent.stopPropagation();
				let serviceId = $(this).attr('serviceId');
				$('#shopping-row-' + serviceId).remove();
				$(`#bundle-modal-${serviceId}`).remove();
				delete checkoutItems[serviceId];

				// Manipulate the shopping cart cookie to remove this chosen service.
				let shoppingCookie = Cookies.get(window.serverData.checkoutCookieName);
				if (shoppingCookie) {
					let shoppingCart = JSON.parse(shoppingCookie);
					if (shoppingCart) {
						delete shoppingCart[serviceId];
						if (Object.keys(shoppingCart).length === 0) {
							Cookies.remove(window.serverData.checkoutCookieName, { expires: 1, path: '/', domain: window.serverData.checkoutCookieDomain, secure: false, sameSite: 'lax' });
						} else {
							Cookies.set(window.serverData.checkoutCookieName, JSON.stringify(shoppingCart), { expires: 1, path: '/', domain: window.serverData.checkoutCookieDomain, secure: false, sameSite: 'lax' });
						}
					}
				}
				await refreshCart();
			});
		}

	// If there was an error retrieving items for sale, notify the user.
	} else if (cartOffersResponse.status === 'ERROR') {
		let errorBox = $('#errorBox');
		errorBox.html(cartOffersResponse.message);
		errorBox.show();

	// Otherwise, display an error about an unknown status.
	} else {
		let errorBox = $('#errorBox');
		errorBox.html('Received unknown message status from the server.');
		errorBox.show();
	}
};

// Refresh the checkout cart's total cost and visibility.
async function refreshCart () {
	if (Object.keys(checkoutItems).length === 0) {
		$('#checkout-cart-container').html('Your cart is empty.');

	// If enabled, check for a discount from the server.
	} else {
		let total = 0;
		$('.checkout-subtotal').map(function () {
			let serviceCost = parseFloat(this.innerHTML.substr(1));
			total += serviceCost;
		});

		// Display the discount if it's not zero.
		total = total.toFixed(2);
		$('#checkout-total').html(`Total $${total}`);
	}
};

// Add an item listing to the checkout cart.
async function addItemToCart (service, amount) {
	let serviceId = service.serviceId;
	let servicePrice = service.price;
	if (discountMultiplier !== 1.00) {
		servicePrice *= discountMultiplier;
	}
	servicePrice = servicePrice.toFixed(2);
	let serviceName = service.serviceMetadata.name;
	let serviceImage = service.serviceMetadata.image;
	let serviceDescription = service.serviceMetadata.description;
	let cartBody = $('#cartBodyContents');
	let subtotal = (servicePrice * amount).toFixed(2);
	let itemElement = `<tr id="shopping-row-${serviceId}" class="checkout-service-row" serviceId="${serviceId}">
		<td data-th="Product">
			<div class="row">
				<div class="col-sm-3 hidden-xs">
					<img src="${serviceImage}" alt="${serviceName}" class="img-responsive" height="100" width="100"/>
				</div>
				<div class="col-sm-9">
					<h4 class="nomargin">${serviceName}</h4>
					<p id="service-description-${serviceId}">${serviceDescription}</p>
				</div>
			</div>
		</td>
		<td data-th="Price" id="service-price-display-${serviceId}">$${servicePrice}</td>
		<td data-th="Quantity">
			<input id="quantityInput-${serviceId}" serviceId="${serviceId}" servicePrice="${servicePrice}" type="number" class="form-control text-center checkout-quantity-selector" value="${amount}" min="0">
		</td>
		<td id="subtotal-${serviceId}" data-th="Subtotal" class="text-center checkout-subtotal">$${subtotal}</td>
		<td class="actions" data-th="">
			<button id="deleteService-${serviceId}" class="btn btn-danger btn-sm checkout-deletion" serviceId="${serviceId}">
				<i class="fa fa-trash-o"></i>
			</button>
		</td>
	</tr>`;
	cartBody.append(itemElement);
	await refreshCart();
};

// Refresh the recent user's inventory.
async function refreshInventory () {
	try {
		let inventoryResponse = await $.ajax({
			url: window.serverData.inventoryUri,
			headers: { 'Authorization': 'Bearer ' + GAME_TOKEN }
		});

		// Update the list of this player's assets that reside solely on the game database.
		let updatedListGame = $('<ul id="ownedListGame" style="list-style-type:circle"></ul>');
		let inventory = inventoryResponse.inventory;
		if (inventory.length > 0) {
			$('#ownedTitleGame').html('You own the following in-game assets:');
		}
		let updatedGameItems = [];
		for (let i = 0; i < inventory.length; i++) {
			let item = inventory[i];
			let itemId = item.itemId;
			let itemAmount = item.amount;

			// Try to retrieve metadata about each item.
			try {
				let itemMetadataResponse = await $.ajax({
					url: window.serverData.metadataUri + itemId
				});
				let itemMetadata = itemMetadataResponse.metadata;
				let itemName = itemMetadata.name;
				let itemImage = itemMetadata.image;
				let itemDescription = itemMetadata.description;

				updatedGameItems.push({
					id: itemId,
					amount: itemAmount,
					name: itemName,
					description: itemDescription,
					image: itemImage
				});

			// If unable to retrieve an item's metadata, flag such an item.
			} catch (error) {
				updatedGameItems.push({
					id: itemId,
					amount: itemAmount,
					name: 'unknown',
					description: 'unable to retrieve metadata',
					image: ''
				});
			}
		}

		// Update our list and remove the loading indicator.
		gameItems = updatedGameItems;

		// If enabled, show the option to select items which can be ascended.
		let ascendableItems = new Set();
		if (window.serverData.ascensionEnabled) {
			try {
				let screeningResponse = await $.post(window.serverData.screeningUri, {
					unscreenedItems: gameItems
				});

				// Display ascendable items within the inventory in a special way.
				if (screeningResponse.status === 'SCREENED') {
					let screenedItems = screeningResponse.screenedItems;
					for (let i = 0; i < screenedItems.length; i++) {
						let item = screenedItems[i];
						let itemAmount = item.amount;
						let itemId = item.id;
						ascendableItems.add(parseInt(itemId));
						let itemName = item.name;
						let itemDescription = item.description;
						updatedListGame.append('<li>' + itemAmount + ' x (' + itemId + ') ' + itemName + ': ' + itemDescription + '\t\t<input id="amount-' + itemId + '" class="input" itemId="' + itemId + '" type="number" value="0" min="0" max="' + itemAmount + '" step="1" style="float: right"/></li>');
					}

				// If there was a screening error, notify the user.
				} else if (screeningResponse.status === 'ERROR') {
					let errorBox = $('#errorBox');
					errorBox.html(screeningResponse.message);
					errorBox.show();

				// Otherwise, display an error about an unknown status.
				} else {
					let errorBox = $('#errorBox');
					errorBox.html('Received unknown message status from the server.');
					errorBox.show();
				}

			// If unable to screen a user's mintable item inventory, show an error.
			} catch (error) {
				showError('Unable to verify item mintability at this time.');
			}
		}

		// Also display the unascendable items.
		for (let i = 0; i < updatedGameItems.length; i++) {
			let item = updatedGameItems[i];
			let itemAmount = item.amount;
			let itemId = item.id;
			let itemName = item.name;
			let itemDescription = item.description;
			if (!ascendableItems.has(parseInt(itemId))) {
				updatedListGame.append('<li>' + itemAmount + ' x (' + itemId + ') ' + itemName + ': ' + itemDescription + '</li>');
			}
		}
		$('#ownedListGame').html(updatedListGame.html());
		$('#gameServerSpinner').remove();

	// If we were unable to retrieve the server inventory, throw error.
	} catch (error) {
		console.error(error);
		showError('Unable to retrieve the server inventory.');
		$('#ownedListGame').html('Unable to retrieve the server inventory.');
	}
};

// Refresh a user's connection to Enjin in order to update the list of this user's Enjin-owned items if they have a valid address.
async function refreshEnjinConnection () {
	let connectionData = await $.post('/connect');
	console.log(connectionData);
	if (connectionData.status === 'LINKED') {
		USER_ADDRESS = connectionData.address;

		// If the inventory is enabled, display it to the user.
		if (window.serverData.inventoryEnabled) {
			let inventory = connectionData.inventory;
			$('#enjinMessage').html('Your Ethereum address is ' + USER_ADDRESS);
			if (inventory.length > 0) {
				$('#ownedTitleEnjin').html('You own the following Enjin ERC-1155 items:');
			}
			$('#linkingQR').empty();
			$('#mintButton').show();
			let updatedListEnjin = $('<ul id="ownedListEnjin" style="list-style-type:circle"></ul>');
			for (let i = 0; i < inventory.length; i++) {
				let item = inventory[i];
				let itemAmount = item.balance;
				let itemId = item['token_id'];
				let itemURI = item.itemURI;

				// Try to retrieve metadata about each item.
				try {
					let itemMetadataResponse = await $.get(itemURI);
					let itemName = itemMetadataResponse.name;
					let itemImage = itemMetadataResponse.image;
					let itemDescription = itemMetadataResponse.description;

					// Update the actual list for display.
					updatedListEnjin.append('<li>' + itemAmount + ' x (' + itemId + ') ' + itemName + ': ' + itemDescription + '</li>');

				// If unable to retrieve an item's metadata, flag such an item.
				} catch (error) {
					updatedListEnjin.append('<li>' + itemAmount + ' x (' + itemId + ') - unable to retrieve metadata.</li>');
				}
			}
			$('#ownedListEnjin').html(updatedListEnjin.html());
			$('#enjinSpinner').remove();
		}

		// Perform the first-time setup of UI modules once linked to Enjin.
		if (!linkedToEnjin) {
			linkedToEnjin = true;

			// Assigning delegate to ascension selection event handler.
			if (window.serverData.ascensionEnabled) {
				$('#ownedListGame').on('input', '.input', function (changedEvent) {
					let itemValue = parseInt($(this).val());
					let itemId = $(this).attr('itemId');
					ascensionItems[itemId] = itemValue;
				});
			}

			// Show the store section of the page if it is disabled.
			if (window.serverData.storeEnabled) {
				let itemSalePanel = $('#itemSalePanel');
				itemSalePanel.show();

				// Assign delegate to purchase checkout event handler.
				$('#itemsOnSale').on('input', '.input', function (changedEvent) {
					let amount = parseInt($(this).val());
					let serviceId = $(this).attr('serviceId');
					checkoutItems[serviceId] = amount;
				});
			}
		}

		// If the checkout cart is enabled, process changes and display items.
		if (window.serverData.checkoutEnabled) {
			let shoppingCookie = Cookies.get(window.serverData.checkoutCookieName);
			if (previousCartContent !== shoppingCookie) {
				previousCartContent = shoppingCookie;
				if (shoppingCookie) {
					let shoppingCart = JSON.parse(shoppingCookie);
					if (!shoppingCart || Object.keys(shoppingCart).length === 0) {
						$('#checkout-cart-container').html('Your cart is empty.');

					// Initialize the cart with items from the cookie.
					} else {
						await initializeCart(shoppingCart);
					}
				}
			}

			// Remove the spinner since we've finished loading the cart details.
			$('#checkout-cart-spinner').remove();
		}

	// Otherwise, notify the user that they must link an Enjin address.
	} else if (connectionData.status === 'MUST_LINK') {
		linkedToEnjin = false;
		let code = connectionData.code;
		$('#enjinMessage').html('Before you can see your Enjin-backed assets or purchase services you must link your Enjin wallet. Your linking code is: ' + code);
		$('#linkingQR').html('<img src="' + connectionData.qr + '"></img>');
		$('#ownedTitleEnjin').html('You do not own any Enjin ERC-1155 items.');
		$('#ownedListEnjin').empty();
		$('#mintButton').hide();
		$('#enjinSpinner').remove();

	// Otherwise, display an error from the server.
	} else if (connectionData.status === 'ERROR') {
		linkedToEnjin = false;
		let errorBox = $('#errorBox');
		errorBox.html(connectionData.message);
		errorBox.show();

	// Otherwise, display an error about an unknown status.
	} else {
		let errorBox = $('#errorBox');
		errorBox.html('Received unknown message status from the server.');
		errorBox.show();
	}
};

// Update the items that are for sale in the store if the store is enabled.
async function refreshStoreContent () {
	let storeData = await $.post('/sales');
	if (storeData.status === 'SUCCESS') {
		let updatedStoreList = $('<ul id="itemsOnSale" style="list-style-type:circle"></ul>');
		let storeItems = storeData.offers;
		if (storeItems.length > 0) {
			$('#itemsInStock').html('The following items are on sale:');
		}
		for (let i = 0; i < storeItems.length; i++) {
			let item = storeItems[i];
			let serviceId = item.serviceId;
			let availableForSale = item.availableForSale;
			let itemId = item.itemId;
			let itemName = item.name;
			let itemDescription = item.description;
			let itemAmount = item.amount;
			let itemCost = item.cost;

			// Update the actual list for display.
			updatedStoreList.append('<li>' + itemAmount + ' x (' + itemId + ') ' + itemName + ': ' + itemDescription + ' for $' + itemCost + '\t\t<input id="amount-' + serviceId + '" class="input" serviceId="' + serviceId + '" type="number" value="0" min="0" max="' + availableForSale + '" step="1" style="float: right"/></li>');
		}

		// Update our store and remove the loading indicator.
		$('#itemsOnSale').html(updatedStoreList.html());
		$('#itemSaleSpinner').remove();

	// Otherwise, display an error from the server.
	} else if (storeData.status === 'ERROR') {
		let errorBox = $('#errorBox');
		errorBox.html(storeData.message);
		errorBox.show();

	// Otherwise, display an error about an unknown status.
	} else {
		let errorBox = $('#errorBox');
		errorBox.html('Received unknown message status from the server.');
		errorBox.show();
	}
};

// Prepare the PayPal buttons for item checkout.
function preparePayPalButtons () {
	paypal.Buttons({
		style: {
			layout: 'horizontal'
		},

		createOrder: async function () {
			let data = await $.post('/checkout', {
				requestedServices: buildRequestList(),
				paymentMethod: 'PAYPAL'
			});
			return data.orderID;
		},

		// Capture the funds from the transaction and validate approval with server.
		onApprove: async function (data) {
			let status = await $.post('/approve', data);
			if (status === 'OK') {
				Cookies.remove(window.serverData.checkoutCookieName, { expires: 1, path: '/', domain: window.serverData.checkoutCookieDomain, secure: false, sameSite: 'lax' });
				checkoutItems = {};
				await refreshCart();
				showStatusMessage('Your purchase was received and is now pending!');
			} else {
				console.error(status, 'Transaction failed.');
			}
		}
	}).render('#paypal-button-container');
};

// A helper function to check if a given string is a valid Ethereum address or not.
function isAddress (address) {
	try {
		ethers.utils.getAddress(address);
	} catch (error) {
		return false;
	}
	return true;
}

// Prepare the Ether button for item checkout.
async function prepareEtherButton () {
	$('#payWithEther').click(async function () {
		const provider = new ethers.providers.Web3Provider(web3.currentProvider);
		const signer = provider.getSigner();
		const purchaser = web3.eth.accounts[0];

		// Throw an error if unable to retrieve a valid address from MetaMask.
		if (!purchaser || purchaser === 'undefined' || purchaser === '' || !isAddress(purchaser)) {
			showError('Unable to retrieve the server inventory.');

		// Only attempt an Ethereum purchase with a valid address.
		} else {
			showStatusMessage('Thank you for paying with Ether! You will receive a transaction to sign for your order.');

			// Retrieve and sign the payment transaction generated by the server.
			let transaction = await $.post('/checkout', {
				requestedServices: buildRequestList(),
				paymentMethod: 'ETHER',
				purchaser: purchaser
			});
			await signer.sendTransaction(transaction);
		}
	});
};

// Prepares all services being requested by a user for purchase.
function buildRequestList () {
	let order = [];

	// Check if the user is requesting to ascend any items.
	let hasAscension = false;
	let filteredAscensionItems = {};
	for (let itemId in ascensionItems) {
		let requestedAmount = ascensionItems[itemId];
		if (requestedAmount <= 0) {
			continue;
		} else {
			hasAscension = true;
			filteredAscensionItems[itemId] = requestedAmount;
			console.log(itemId, requestedAmount, filteredAscensionItems);
		}
	}

	// If so, then note that ascension is happening in the order.
	if (hasAscension) {
		order.push({
			id: 'ASCENSION',
			checkoutItems: filteredAscensionItems
		});
	}

	// Check if the user has requested to buy any services.
	for (let serviceId in checkoutItems) {
		let requestedAmount = checkoutItems[serviceId];
		if (requestedAmount <= 0) {
			continue;
		} else {
			order.push({
				id: serviceId,
				amount: requestedAmount
			});
		}
	}
	return order;
};

// A function which asynchronously sets up the page.
let setup = async function () {
	console.log(`Setting up page. Profile: ${window.serverData.profileEnabled}; Inventory: ${window.serverData.inventoryEnabled}; Ascension: ${window.serverData.ascensionEnabled}; Store: ${window.serverData.storeEnabled}; Checkout: ${window.serverData.checkoutEnabled}.`);

	// Get the user's access token and identity.
	GAME_TOKEN = Cookies.get('gameToken');

	// Display the panel for loading profile data if enabled.
	if (window.serverData.profileEnabled) {
		$('#profile-panel').show();
	}

	// Display the panel for loading inventory data if enabled.
	if (window.serverData.inventoryEnabled) {
		$('#inventory-panel').show();
	}

	// Display the panel for loading the checkout cart if enabled.
	if (window.serverData.checkoutEnabled) {
		$('#checkout-cart-panel').show();
	}

	// Try to retrieve the user's profile information.
	try {
		let profileResponse = await $.ajax({
			url: window.serverData.profileUri,
			headers: { 'Authorization': 'Bearer ' + GAME_TOKEN }
		});

		// Get all of the profile fields.
		let username = profileResponse.username;
		let email = profileResponse.email;
		USER_ADDRESS = profileResponse.lastAddress;
		let kills = profileResponse.Kills;
		let deaths = profileResponse.Deaths;
		let assists = profileResponse.Assists;
		let accuracy = profileResponse.Accuracy;
		let wins = profileResponse.Wins;
		let losses = profileResponse.Losses;

		// Display the fields to the user if profile display is enabled.
		let updatedProfileList = $('<ul id="profileInformation" style="list-style-type:circle"></ul>');
		updatedProfileList.append('<li>Your username: ' + username + '</li>');
		updatedProfileList.append('<li>Your email: ' + email + '</li>');
		updatedProfileList.append('<li>Your kills: ' + kills + '</li>');
		updatedProfileList.append('<li>Your deaths: ' + deaths + '</li>');
		updatedProfileList.append('<li>Your assists: ' + assists + '</li>');
		updatedProfileList.append('<li>Your accuracy: ' + accuracy + '</li>');
		updatedProfileList.append('<li>Your wins: ' + wins + '</li>');
		updatedProfileList.append('<li>Your losses: ' + losses + '</li>');

		// Update our list and remove the loading indicator.
		$('#profileInformation').html(updatedProfileList.html());
		$('#profileSpinner').remove();

	// If unable to retrieve the user profile information, show an error.
	} catch (error) {
		console.error(error);
		showError('Unable to retrieve user profile.');
	}

	// Assign functionality to the example logout button.
	$('#logoutButton').click(async function () {
		$.post('/logout', function (data) {
			window.location.replace('/');
		});
	});

	// Periodically refresh this page's content automatically.
	let updateStatus = async function () {
		if (window.serverData.inventoryEnabled) {
			await refreshInventory();
		}
		await refreshEnjinConnection();
		if (window.serverData.storeEnabled) {
			await refreshStoreContent();
		}
	};
	await updateStatus();
	setInterval(updateStatus, 30000);
};

// If Ether payments are enabled, we must request permission to enable Web3.
window.addEventListener('load', async () => {
	if (window.serverData.checkoutEnabled && window.serverData.etherEnabled) {
		$('#web3-panel').show();
		if (window.ethereum) {
			window.web3 = new Web3(window.ethereum);

			// If Ethereum is present, try to access it.
			try {
				await window.ethereum.enable();
				window.ethereum.autoRefreshOnNetworkChange = false;
				$('#web3-panel').hide();
				hasValidWeb3 = true;

			// Otherwise, flag Web3 as unavailable.
			} catch (error) {
				console.error(error);
				showError('Issue with Ethereum detected. You should consider trying MetaMask!');
				$('#web3-panel').hide();
				hasValidWeb3 = false;
			}

		// Otherwise, attempt to use the current Web3 context.
		}	else if (window.web3) {
			window.web3 = new Web3(window.web3.currentProvider);
			$('#web3-panel').hide();
			hasValidWeb3 = true;

		// Otherwise, notify the user of this error.
		}	else {
			console.error('Non-Ethereum browser detected. Please install MetaMask to pay with ETH.');
			showError('Non-Ethereum browser detected. Please install MetaMask to pay with ETH.');
			$('#web3-panel').hide();
			hasValidWeb3 = false;
		}
	}

	// Set up the rest of the page.
	setup();
});
