cask "openpond-app" do
  version "0.1.0"
  sha256 "0e0e21fd01f57d4c6f9a9b1a1e75d5090aa68197246c4512a2e68e2c6113c8c1"

  url "https://github.com/openpond/openpond-app/releases/download/v#{version}/OpenPond%20App-#{version}-mac.zip"
  name "OpenPond App"
  desc "OpenPond desktop and local server app"
  homepage "https://openpond.ai"

  app "OpenPond App.app"
end
