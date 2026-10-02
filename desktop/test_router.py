from frontend.command_router import CommandRouter

router = CommandRouter()

tests = [
    "Show me F-8 imagery",
    "Load Centaurus",
    "Fetch satellite imagery of NUST",
    "Open Blue Area",
    "Display I-8",
    "What is NDVI?",
    "Explain KMeans",
]

for t in tests:
    print("-" * 60)
    print(t)
    print(router.route(t))