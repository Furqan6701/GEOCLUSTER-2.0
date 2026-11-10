import os
from playwright.sync_api import sync_playwright

image_path = os.path.abspath('docs/demo/F8_satellite.png')
print('Testing upload of:', image_path)

with sync_playwright() as p:
    browser = p.chromium.launch(channel='chrome', headless=True)
    page = browser.new_page(viewport={'width': 1920, 'height': 1080})
    page.goto('http://localhost:8010/')
    page.wait_for_selector('#viewer-original')
    print('Original viewer found')
    
    file_inputs = page.locator('input[type="file"]').all()
    print('Found file inputs:', len(file_inputs))
    for i, inp in enumerate(file_inputs):
        print(f'Input {i}: id={inp.get_attribute("id")} accept={inp.get_attribute("accept")}')
    
    file_inputs[0].set_input_files(image_path)
    print('File input set')
    page.wait_for_timeout(3000)
    
    print('Status size:', page.locator('#sb-size').inner_text())
    print('Status source:', page.locator('#sb-source').inner_text())
    print('Toasts:', [t.inner_text() for t in page.locator('.toast').all()])
    browser.close()
