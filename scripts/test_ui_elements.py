"""Test UI elements and interactions for GeoCluster 2.0.
"""

import os
from playwright.sync_api import sync_playwright

image_path = os.path.abspath('docs/demo/F8_satellite.png')

with sync_playwright() as p:
    browser = p.chromium.launch(channel='chrome', headless=True)
    page = browser.new_page(viewport={'width': 1920, 'height': 1080})
    page.goto('http://localhost:8010/')
    page.wait_for_selector('#viewer-original')
    
    # 1. Upload image
    print("1. Uploading image...")
    file_input = page.locator('input[type="file"]').first
    file_input.set_input_files(image_path)
    page.wait_for_timeout(2000)
    print("   Image loaded. Status:", page.locator('#sb-size').inner_text())

    # 2. Test Filters
    print("2. Testing Filters...")
    # Find filter buttons in Toolbox -> Filters
    # Let's inspect buttons inside #toolbox
    buttons = page.locator('#toolbox button').all()
    print("   Toolbox buttons count:", len(buttons))
    btn_texts = [b.inner_text().strip() for b in buttons if b.inner_text().strip()]
    print("   Toolbox button names:", btn_texts[:15])

    # Let's check Grayscale button
    gray_btn = page.locator('button:has-text("Grayscale")').first
    if gray_btn.is_visible():
        print("   Clicking Grayscale...")
        gray_btn.click()
        page.wait_for_timeout(1500)
        print("   Result size:", page.locator('#sb-lastop').inner_text() if page.locator('#sb-lastop').count() else "ok")

    # Let's check Undo
    undo_btn = page.locator('#tb-undo')
    print("   Undo disabled?", undo_btn.is_disabled())
    if not undo_btn.is_disabled():
        undo_btn.click()
        page.wait_for_timeout(1000)
        print("   Undone. Status:", page.locator('#sb-history').inner_text())

    # 3. Test K-Means in Clusters section
    print("3. Testing Clusters section...")
    clusters_head = page.locator('button:has-text("Clusters")').first
    if clusters_head.is_visible():
        clusters_head.click()
        page.wait_for_timeout(1000)
    kmeans_btn = page.locator('button:has-text("Run K-Means")').first
    print("   Run K-Means visible?", kmeans_btn.is_visible())
    if kmeans_btn.is_visible():
        kmeans_btn.click()
        page.wait_for_timeout(2500)
        print("   K-Means completed! Toast count:", page.locator('.toast').count())

    # 4. Map composer
    print("4. Testing Map Composer...")
    map_btn = page.locator('#tb-map')
    print("   Map button visible?", map_btn.is_visible())
    map_btn.click()
    page.wait_for_timeout(1500)
    # Check if modal opened
    composer = page.locator('.mapstudio-modal, .map-composer-modal, dialog, [role="dialog"]')
    print("   Dialog count:", composer.count())
    page.keyboard.press("Escape")
    page.wait_for_timeout(1000)

    # 5. Histogram
    print("5. Testing Histogram...")
    histo_btn = page.locator('button:has-text("Histogram")').first
    print("   Histogram button visible?", histo_btn.is_visible())
    histo_btn.click()
    page.wait_for_timeout(1500)
    windows = page.locator('.histowindow, .histogram-window, .window')
    print("   Histogram window count:", windows.count())
    page.keyboard.press("Escape")
    page.wait_for_timeout(1000)

    # 6. Assistant chat
    print("6. Testing Assistant...")
    chat_input = page.locator('#chat-input, input[placeholder*="Ask"], textarea[placeholder*="Ask"]')
    print("   Chat input count:", chat_input.count())
    if chat_input.count() > 0:
        chat_input.first.fill("What is the mean filter?")
        chat_input.first.press("Enter")
        page.wait_for_timeout(2500)
        messages = page.locator('.chat-msg, .chat-message, .bubble').all()
        print("   Chat messages count:", len(messages))
        if messages:
            print("   Last message:", messages[-1].inner_text())

    browser.close()
    print("Test completed successfully!")
