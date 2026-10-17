import Foundation
import Security

struct Input: Decodable {
    let pkcs12Base64: String
    let importPassword: String
    let keychainPassword: String
}

func checked(_ status: OSStatus) throws {
    if status != errSecSuccess { throw NSError(domain: "SigningIdentityImport", code: Int(status)) }
}

do {
    guard CommandLine.arguments.count == 2 else { throw NSError(domain: "SigningIdentityInput", code: 1) }
    let input = try JSONDecoder().decode(Input.self, from: FileHandle.standardInput.readDataToEndOfFile())
    guard let certificate = Data(base64Encoded: input.pkcs12Base64) else { throw NSError(domain: "SigningIdentityInput", code: 2) }
    try checked(SecKeychainSetUserInteractionAllowed(false))
    var keychain: SecKeychain?
    let password = Array(input.keychainPassword.utf8)
    try password.withUnsafeBytes { bytes in
        try checked(SecKeychainCreate(CommandLine.arguments[1], UInt32(bytes.count), bytes.baseAddress, false, nil, &keychain))
    }
    guard let keychain else { throw NSError(domain: "SigningIdentityInput", code: 3) }
    var trusted: SecTrustedApplication?
    try checked(SecTrustedApplicationCreateFromPath("/usr/bin/codesign", &trusted))
    guard let trusted else { throw NSError(domain: "SigningIdentityInput", code: 4) }
    var access: SecAccess?
    try checked(SecAccessCreate("Azure Nightly ephemeral signing" as CFString, [trusted] as CFArray, &access))
    var format = SecExternalFormat.formatPKCS12
    var itemType = SecExternalItemType.itemTypeAggregate
    var parameters = SecItemImportExportKeyParameters()
    parameters.version = UInt32(SEC_KEY_IMPORT_EXPORT_PARAMS_VERSION)
    parameters.passphrase = Unmanaged.passUnretained(input.importPassword as CFString)
    guard let access else { throw NSError(domain: "SigningIdentityInput", code: 5) }
    parameters.accessRef = Unmanaged.passUnretained(access)
    try checked(SecItemImport(certificate as CFData, nil, &format, &itemType, [], &parameters, keychain, nil))
} catch {
    FileHandle.standardError.write(Data("Signing identity import failed.\n".utf8))
    exit(1)
}
